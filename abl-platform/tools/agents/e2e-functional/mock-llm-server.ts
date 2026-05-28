/**
 * Mock OpenAI-compatible LLM server for E2E functional tests.
 *
 * Implements POST /v1/chat/completions with:
 * - Pattern-based canned responses
 * - Tool call simulation
 * - Streaming (SSE) support
 * - Request capture for assertions
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type {
  DynamicToolCall,
  MockErrorResponse,
  MockLLM,
  MockResponse,
  MockToolCall,
  OpenAIChatMessageContent,
  OpenAIChatRequest,
} from './types.js';

interface Registration {
  pattern: string;
  response?: MockResponse;
  toolCall?: MockToolCall;
  dynamicToolCall?: DynamicToolCall;
  errorResponse?: MockErrorResponse;
}

export async function startMockLLM(): Promise<MockLLM> {
  const registrations: Registration[] = [];
  let lastRequest: OpenAIChatRequest | undefined;
  const requests: OpenAIChatRequest[] = [];
  let requestCounter = 0;

  function stringifyMessageContent(content: OpenAIChatMessageContent): string {
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

          const imageUrl = part.image_url;
          if (typeof imageUrl === 'string') {
            return JSON.stringify({ ...part, image_url: imageUrl });
          }

          if (imageUrl && typeof imageUrl === 'object') {
            return JSON.stringify({
              ...part,
              image_url: {
                url: typeof imageUrl.url === 'string' ? imageUrl.url : undefined,
                detail: typeof imageUrl.detail === 'string' ? imageUrl.detail : undefined,
              },
            });
          }

          return JSON.stringify(part);
        })
        .filter(Boolean)
        .join('\n');
    }

    return JSON.stringify(content);
  }

  function contentHasToolResult(content: OpenAIChatMessageContent): boolean {
    if (Array.isArray(content)) {
      return content.some((part) => {
        if (typeof part === 'string') {
          return part.includes('tool_result');
        }

        if (!part || typeof part !== 'object') {
          return false;
        }

        return (
          part.type === 'tool_result' || stringifyMessageContent([part]).includes('tool_result')
        );
      });
    }

    return stringifyMessageContent(content).includes('tool_result');
  }

  function findMatch(userMessage: string): Registration | undefined {
    // Search in reverse so later registrations take priority
    for (let i = registrations.length - 1; i >= 0; i--) {
      if (userMessage.toLowerCase().includes(registrations[i].pattern.toLowerCase())) {
        return registrations[i];
      }
    }
    return undefined;
  }

  function extractLastUserMessage(
    messages: Array<{ role: string; content: OpenAIChatMessageContent }>,
  ): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && messages[i].content) {
        return stringifyMessageContent(messages[i].content);
      }
    }
    return '';
  }

  function buildMessageCorpus(
    messages: Array<{ role: string; content: OpenAIChatMessageContent }>,
  ): string {
    return messages
      .map((message) => stringifyMessageContent(message.content))
      .filter((content) => content.length > 0)
      .join('\n\n');
  }

  /**
   * Resolve dynamic tool call arguments by extracting values from the
   * message corpus using the configured regex extractors.
   */
  function resolveDynamicToolCallArgs(
    dynToolCall: DynamicToolCall,
    corpus: string,
  ): Record<string, unknown> {
    const args: Record<string, unknown> = { ...(dynToolCall.staticArgs ?? {}) };
    for (const [argName, regex] of Object.entries(dynToolCall.argExtractors)) {
      const match = corpus.match(regex);
      if (match) {
        // Use group 0 (full match) as the argument value
        args[argName] = match[0];
      }
    }
    return args;
  }

  function buildNonStreamingResponse(
    match: Registration | undefined,
    requestId: string,
    corpus: string,
  ): string {
    // Handle dynamic tool call (extract args from corpus)
    if (match?.dynamicToolCall) {
      const args = resolveDynamicToolCallArgs(match.dynamicToolCall, corpus);
      return JSON.stringify({
        id: requestId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call_${requestId}`,
                  type: 'function',
                  function: {
                    name: match.dynamicToolCall.name,
                    arguments: JSON.stringify(args),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      });
    }

    if (match?.toolCall) {
      return JSON.stringify({
        id: requestId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call_${requestId}`,
                  type: 'function',
                  function: {
                    name: match.toolCall.name,
                    arguments: JSON.stringify(match.toolCall.arguments),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      });
    }

    const content = match?.response?.content ?? 'Mock LLM default response.';
    const finishReason = match?.response?.finishReason ?? 'stop';

    return JSON.stringify({
      id: requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: finishReason,
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    });
  }

  function writeStreamingResponse(
    res: ServerResponse,
    match: Registration | undefined,
    requestId: string,
    corpus: string,
  ): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Handle streaming dynamic tool calls
    if (match?.dynamicToolCall) {
      const args = resolveDynamicToolCallArgs(match.dynamicToolCall, corpus);
      const argsStr = JSON.stringify(args);
      const roleChunk = JSON.stringify({
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: `call_${requestId}`,
                  type: 'function',
                  function: { name: match.dynamicToolCall.name, arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      res.write(`data: ${roleChunk}\n\n`);

      const argChunkSize = Math.ceil(argsStr.length / 2);
      for (let i = 0; i < argsStr.length; i += argChunkSize) {
        const argData = JSON.stringify({
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'mock-model',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: argsStr.slice(i, i + argChunkSize) } },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        res.write(`data: ${argData}\n\n`);
      }

      const finalData = JSON.stringify({
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      });
      res.write(`data: ${finalData}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Handle streaming tool calls
    if (match?.toolCall) {
      const argsStr = JSON.stringify(match.toolCall.arguments);
      // Stream the tool call: first chunk with function name, then argument chunks
      const roleChunk = JSON.stringify({
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: `call_${requestId}`,
                  type: 'function',
                  function: { name: match.toolCall.name, arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      res.write(`data: ${roleChunk}\n\n`);

      // Stream arguments in ~2 chunks
      const argChunkSize = Math.ceil(argsStr.length / 2);
      for (let i = 0; i < argsStr.length; i += argChunkSize) {
        const argData = JSON.stringify({
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'mock-model',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: argsStr.slice(i, i + argChunkSize) } },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        res.write(`data: ${argData}\n\n`);
      }

      // Final chunk
      const finalData = JSON.stringify({
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      });
      res.write(`data: ${finalData}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const content = match?.response?.content ?? 'Mock LLM default response.';
    // Split content into ~3 chunks
    const chunkSize = Math.ceil(content.length / 3);
    const chunks: string[] = [];
    for (let i = 0; i < content.length; i += chunkSize) {
      chunks.push(content.slice(i, i + chunkSize));
    }

    // Send each chunk as a delta
    for (let i = 0; i < chunks.length; i++) {
      const data = JSON.stringify({
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
        choices: [
          {
            index: 0,
            delta: i === 0 ? { role: 'assistant', content: chunks[i] } : { content: chunks[i] },
            finish_reason: null,
          },
        ],
      });
      res.write(`data: ${data}\n\n`);
    }

    // Final chunk with finish_reason
    const finalData = JSON.stringify({
      id: requestId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-model',
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: match?.response?.finishReason ?? 'stop',
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    });
    res.write(`data: ${finalData}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Only handle POST /v1/chat/completions
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: 'Not found', type: 'invalid_request_error' },
        }),
      );
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        let parsed: OpenAIChatRequest;
        try {
          parsed = JSON.parse(body) as OpenAIChatRequest;
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { message: 'Invalid JSON', type: 'invalid_request_error' },
            }),
          );
          return;
        }

        lastRequest = parsed;
        requests.push(parsed);
        if (requests.length > 500) requests.shift();
        requestCounter++;
        const requestId = `chatcmpl-mock-${requestCounter}`;

        const userMessage = extractLastUserMessage(parsed.messages);
        const messageCorpus = buildMessageCorpus(parsed.messages);

        // Check if this is a tool result follow-up
        const hasToolResult = parsed.messages.some(
          (m) => m.role === 'tool' || (m.role === 'user' && contentHasToolResult(m.content)),
        );

        let match = findMatch(userMessage);
        if (!match) {
          match = findMatch(messageCorpus);
        }

        // If this looks like a tool result follow-up, return the followUpContent
        if (hasToolResult && match?.toolCall) {
          const followUp: Registration = {
            pattern: match.pattern,
            response: { content: match.toolCall.followUpContent },
          };
          match = followUp;
        }
        if (hasToolResult && match?.dynamicToolCall) {
          const followUp: Registration = {
            pattern: match.pattern,
            response: { content: match.dynamicToolCall.followUpContent },
          };
          match = followUp;
        }

        // ── Error simulation: return HTTP error instead of completion ──
        if (match?.errorResponse) {
          res.writeHead(match.errorResponse.status, {
            'Content-Type': 'application/json',
          });
          res.end(JSON.stringify(match.errorResponse.body));
          return;
        }

        if (parsed.stream) {
          writeStreamingResponse(res, match, requestId, messageCorpus);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(buildNonStreamingResponse(match, requestId, messageCorpus));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Mock LLM internal error';
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message,
              type: 'server_error',
            },
          }),
        );
      }
    });
  }

  const server = createServer(handleRequest);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    register(pattern: string, response: MockResponse): void {
      registrations.push({ pattern, response });
    },
    registerToolCall(pattern: string, toolCall: MockToolCall): void {
      registrations.push({ pattern, toolCall });
    },
    registerDynamicToolCall(pattern: string, dynamicToolCall: DynamicToolCall): void {
      registrations.push({ pattern, dynamicToolCall });
    },
    registerError(pattern: string, errorResponse: MockErrorResponse): void {
      registrations.push({ pattern, errorResponse });
    },
    getLastRequest(): OpenAIChatRequest | undefined {
      return lastRequest;
    },
    getAllRequests(): OpenAIChatRequest[] {
      return requests;
    },
    reset(): void {
      registrations.length = 0;
      lastRequest = undefined;
      requests.length = 0;
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
