// apps/runtime/src/__tests__/e2e/ai4hc-payer/sse-client.ts

/**
 * AI4HC Payer Kore.ai SSE Streaming Client
 *
 * Handles: session identity, SSE parsing, timing, agent detection.
 */

export interface SessionIdentity {
  userReference: string;
  sessionReference: string;
}

export interface SSEEvent {
  eventIndex?: number;
  sessionInfo?: { sessionId: string };
  sessionReference?: string;
  agent?: { displayName: string; icon?: string; title?: string };
  output?: Array<{ type: string; content: string }>;
  token?: string;
  message?: string;
  type?: string;
}

export interface ParsedResponse {
  sessionId: string | null;
  sessionReference: string | null;
  agentInfo: { displayName: string; icon?: string } | null;
  fullText: string;
  events: SSEEvent[];
  rawChunks: string[];
  timing: {
    startMs: number;
    firstChunkMs: number;
    firstTokenMs: number;
    endMs: number;
  };
}

export interface AI4HCClientConfig {
  apiKey: string;
  appId: string;
  baseUrl: string;
  environment?: string;
}

/**
 * Parse concatenated JSON objects from an SSE data line.
 */
export function extractJSONObjects(line: string): string[] {
  const stripped = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
  if (!stripped) return [];

  const objects: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(stripped.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

/**
 * Parse a Kore.ai SSE stream into structured events with timing data.
 */
export async function parseSSEStream(response: Response, startMs: number): Promise<ParsedResponse> {
  const result: ParsedResponse = {
    sessionId: null,
    sessionReference: null,
    agentInfo: null,
    fullText: '',
    events: [],
    rawChunks: [],
    timing: { startMs, firstChunkMs: 0, firstTokenMs: 0, endMs: 0 },
  };

  if (!response.body) {
    throw new Error(`No response body — status ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let isFirstChunk = true;
  let isFirstToken = true;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    if (isFirstChunk) {
      result.timing.firstChunkMs = Date.now();
      isFirstChunk = false;
    }

    const chunk = decoder.decode(value, { stream: true });
    result.rawChunks.push(chunk);
    buffer += chunk;

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (
        !trimmed ||
        trimmed.startsWith('event:') ||
        trimmed.startsWith('id:') ||
        trimmed.startsWith('retry:')
      ) {
        continue;
      }

      const jsonStrings = extractJSONObjects(trimmed);
      for (const jsonStr of jsonStrings) {
        try {
          const data: SSEEvent = JSON.parse(jsonStr);
          result.events.push(data);

          if (data.sessionInfo?.sessionId) {
            result.sessionId = data.sessionInfo.sessionId;
          }
          if (data.sessionReference) {
            result.sessionReference = data.sessionReference;
          }
          if (data.agent?.displayName) {
            result.agentInfo = data.agent;
          }

          if (data.output) {
            for (const item of data.output) {
              if (item.type === 'text' && item.content) {
                if (isFirstToken) {
                  result.timing.firstTokenMs = Date.now();
                  isFirstToken = false;
                }
                result.fullText += item.content;
              }
            }
          }
          if (data.token) {
            if (isFirstToken) {
              result.timing.firstTokenMs = Date.now();
              isFirstToken = false;
            }
            result.fullText += data.token;
          }
        } catch {
          // Partial JSON — reassembled in next chunk
        }
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    const jsonStrings = extractJSONObjects(buffer);
    for (const jsonStr of jsonStrings) {
      try {
        const data: SSEEvent = JSON.parse(jsonStr);
        result.events.push(data);
        if (data.output) {
          for (const item of data.output) {
            if (item.type === 'text' && item.content) {
              result.fullText += item.content;
            }
          }
        }
      } catch {
        // ignore
      }
    }
  }

  result.timing.endMs = Date.now();
  return result;
}

/**
 * Send a message to the Kore.ai AI4HC API and parse the SSE response.
 */
export async function sendMessage(
  config: AI4HCClientConfig,
  text: string,
  identity: SessionIdentity,
): Promise<ParsedResponse> {
  const environment = config.environment ?? 'UAT';
  const executeUrl = `${config.baseUrl}/api/v2/apps/${config.appId}/environments/${environment}/runs/execute`;

  const body = {
    sessionIdentity: [
      { type: 'userReference', value: identity.userReference },
      { type: 'sessionReference', value: identity.sessionReference },
    ],
    input: [{ type: 'text', content: text }],
    stream: { enable: true, streamMode: 'tokens' },
    debug: { enable: false },
  };

  const startMs = Date.now();

  const response = await fetch(executeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Kore.ai API error: ${response.status} ${response.statusText}\n${errText}`);
  }

  return parseSSEStream(response, startMs);
}

/**
 * Create a unique session identity for a test run.
 */
export function makeSessionIdentity(prefix = 'ai4hc_e2e'): SessionIdentity {
  const ts = Date.now();
  return {
    userReference: `${prefix}_user_${ts}`,
    sessionReference: `${prefix}_session_${ts}`,
  };
}

/**
 * Timing formatter.
 */
export function fmt(ms: number): string {
  return (ms / 1000).toFixed(2) + 's';
}
