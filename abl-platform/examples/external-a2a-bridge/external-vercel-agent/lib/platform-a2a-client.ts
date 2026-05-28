import {
  createError,
  createSuccess,
  isRecord,
  toText,
  type A2AMessageSendParams,
  type A2APart,
  type ConversationTurn,
  type JsonRpcId,
} from './a2a-types';
import { log } from './logger';

interface PlatformCallOptions {
  contextId: string;
  prefix: 'platform research' | 'platform file';
  text: string;
  history: ConversationTurn[];
  messageMetadata?: Record<string, unknown>;
  filePart?: A2APart;
}

function requirePlatformEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function getHeaders(): HeadersInit {
  const token = process.env.PLATFORM_A2A_BEARER_TOKEN?.trim();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function buildMessagePayload(options: PlatformCallOptions): A2AMessageSendParams {
  const parts: A2APart[] = [
    {
      kind: 'text',
      text: `${options.prefix} ${options.text}`.trim(),
    },
  ];

  if (options.filePart) {
    parts.push(options.filePart);
  }

  return {
    message: {
      kind: 'message',
      messageId: `msg-${options.contextId}-${Date.now()}`,
      role: 'user',
      contextId: options.contextId,
      parts,
      metadata: {
        history: options.history,
        ...(options.messageMetadata ? { messageMetadata: options.messageMetadata } : {}),
      },
    },
  };
}

async function sendPlatformMessage(options: PlatformCallOptions): Promise<string> {
  const endpoint = requirePlatformEnv('PLATFORM_A2A_URL');
  const rpcId: JsonRpcId = `rpc-${Date.now()}`;
  const payload = {
    jsonrpc: '2.0',
    id: rpcId,
    method: 'message/send',
    params: buildMessagePayload(options),
  };

  log.info('Calling platform A2A endpoint', {
    endpoint,
    contextId: options.contextId,
    prefix: options.prefix,
  });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Platform A2A call failed with ${response.status}: ${body}`);
  }

  const json = (await response.json()) as unknown;
  if (!isRecord(json)) {
    throw new Error('Platform A2A response was not an object');
  }

  if ('error' in json && isRecord(json.error)) {
    throw new Error(String(json.error.message ?? 'Unknown platform A2A error'));
  }

  if (!('result' in json) || !isRecord(json.result)) {
    throw new Error('Platform A2A response was missing a result object');
  }

  const result = json.result;
  if (result.kind === 'message' && Array.isArray(result.parts)) {
    return result.parts
      .map((part) => toText(part))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (result.kind === 'task' && isRecord(result.status)) {
    return `Platform accepted the callback task and reported state: ${String(result.status.state ?? 'unknown')}.`;
  }

  return JSON.stringify(result);
}

export async function askPlatformResearch(params: {
  conversationId: string;
  question: string;
  history: ConversationTurn[];
}): Promise<string> {
  return sendPlatformMessage({
    contextId: `${params.conversationId}:platform-research`,
    prefix: 'platform research',
    text: params.question,
    history: params.history,
    messageMetadata: {
      source: 'external-vercel-agent',
      callbackType: 'research',
    },
  });
}

export async function sendTranscriptFileToPlatform(params: {
  conversationId: string;
  note: string;
  filename: string;
  markdown: string;
  history: ConversationTurn[];
}): Promise<string> {
  return sendPlatformMessage({
    contextId: `${params.conversationId}:platform-file`,
    prefix: 'platform file',
    text: params.note,
    history: params.history,
    messageMetadata: {
      source: 'external-vercel-agent',
      callbackType: 'file_delivery',
      filename: params.filename,
    },
    filePart: {
      kind: 'file',
      file: {
        name: params.filename,
        mimeType: 'text/plain',
        bytes: Buffer.from(params.markdown, 'utf8').toString('base64'),
      },
    },
  });
}
