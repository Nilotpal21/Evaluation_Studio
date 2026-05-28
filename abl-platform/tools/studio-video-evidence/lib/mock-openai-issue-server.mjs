import { createServer } from 'node:http';

export function stringifyMessageContent(content) {
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

export function extractLastUserMessage(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      return stringifyMessageContent(message.content);
    }
  }

  return '';
}

export function buildMessageCorpus(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  return messages
    .map((message) => stringifyMessageContent(message?.content))
    .filter((value) => value.length > 0)
    .join('\n\n');
}

function buildChatCompletionBody(spec, requestId) {
  if (spec?.toolCall) {
    return JSON.stringify({
      id: requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: spec.model ?? 'mock-issue-model',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: spec.toolCall.id ?? `call_${requestId}`,
                type: 'function',
                function: {
                  name: spec.toolCall.name,
                  arguments: JSON.stringify(spec.toolCall.arguments ?? {}),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: spec.usage?.promptTokens ?? 48,
        completion_tokens: spec.usage?.completionTokens ?? 18,
        total_tokens: (spec.usage?.promptTokens ?? 48) + (spec.usage?.completionTokens ?? 18),
      },
    });
  }

  return JSON.stringify({
    id: requestId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: spec?.model ?? 'mock-issue-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: spec?.content ?? 'Mock issue server response.',
        },
        finish_reason: spec?.finishReason ?? 'stop',
      },
    ],
    usage: {
      prompt_tokens: spec?.usage?.promptTokens ?? 48,
      completion_tokens: spec?.usage?.completionTokens ?? 18,
      total_tokens: (spec?.usage?.promptTokens ?? 48) + (spec?.usage?.completionTokens ?? 18),
    },
  });
}

export async function startIssueMockOpenAIServer({ handleRequest }) {
  const requests = [];
  let requestCounter = 0;

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not found', type: 'invalid_request_error' } }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }),
        );
        return;
      }

      requests.push(parsed);
      if (requests.length > 200) {
        requests.shift();
      }

      requestCounter += 1;
      const requestId = `chatcmpl-issue-${requestCounter}`;

      try {
        const spec =
          (await handleRequest(parsed, {
            requestId,
            requests: [...requests],
            extractLastUserMessage,
            stringifyMessageContent,
            buildMessageCorpus,
          })) ?? {};

        res.writeHead(spec.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(buildChatCompletionBody(spec, requestId));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: error instanceof Error ? error.message : String(error),
              type: 'server_error',
            },
          }),
        );
      }
    });
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    getRequests() {
      return [...requests];
    },
    clearRequests() {
      requests.length = 0;
    },
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
