export type JsonRpcId = string | number | null;

export interface A2ATextPart {
  kind: 'text';
  text: string;
}

export interface A2ADataPart {
  kind: 'data';
  data: unknown;
}

export interface A2AFilePart {
  kind: 'file';
  file: {
    name?: string;
    mimeType?: string;
    bytes?: string;
    uri?: string;
  };
}

export type A2APart = A2ATextPart | A2ADataPart | A2AFilePart;

export interface A2AMessage {
  kind: 'message';
  messageId: string;
  role: 'user' | 'agent';
  contextId?: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export interface A2AMessageSendParams {
  message: A2AMessage;
  metadata?: Record<string, unknown>;
  configuration?: {
    blocking?: boolean;
    pushNotificationConfig?: {
      url: string;
      token?: string;
    };
  };
}

export interface A2AJsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface A2AJsonRpcError {
  code: number;
  message: string;
}

export interface A2AJsonRpcSuccess<T> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: T;
}

export interface A2AJsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: A2AJsonRpcError;
}

export interface ConversationTurn {
  role: string;
  content: string;
}

export interface InboundAttachmentSummary {
  name?: string;
  mimeType?: string;
  bytes?: string;
  uri?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createSuccess<T>(id: JsonRpcId, result: T): A2AJsonRpcSuccess<T> {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

export function createError(id: JsonRpcId, code: number, message: string): A2AJsonRpcFailure {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  };
}

export function toText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => toText(item))
      .filter((item) => item.length > 0)
      .join('\n');
  }

  if (isRecord(value)) {
    if (value.kind === 'text' && typeof value.text === 'string') {
      return value.text;
    }

    if (value.kind === 'data') {
      return JSON.stringify(value.data);
    }
  }

  if (value === undefined || value === null) {
    return '';
  }

  return JSON.stringify(value);
}
