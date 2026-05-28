import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  createError,
  createSuccess,
  isRecord,
  toText,
  type A2AFilePart,
  type A2AJsonRpcRequest,
  type A2AMessage,
  type ConversationTurn,
  type InboundAttachmentSummary,
} from '../../../lib/a2a-types';
import { runHostedBridgeAgent } from '../../../lib/hosted-bridge-agent';
import { log } from '../../../lib/logger';

export const runtime = 'nodejs';

function extractMessage(params: Record<string, unknown> | undefined): A2AMessage | null {
  const candidate = params?.message;
  if (!isRecord(candidate)) {
    return null;
  }

  if (
    candidate.kind !== 'message' ||
    typeof candidate.messageId !== 'string' ||
    typeof candidate.role !== 'string' ||
    !Array.isArray(candidate.parts)
  ) {
    return null;
  }

  return candidate as unknown as A2AMessage;
}

function extractHistory(message: A2AMessage): ConversationTurn[] {
  const history = message.metadata?.history;
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => ({
      role: typeof item.role === 'string' ? item.role : 'unknown',
      content: toText(item.content),
    }));
}

function extractCurrentText(message: A2AMessage): string {
  return message.parts
    .filter((part) => part.kind === 'text' || part.kind === 'data')
    .map((part) => toText(part))
    .filter((text) => text.length > 0)
    .join('\n')
    .trim();
}

function extractAttachments(message: A2AMessage): InboundAttachmentSummary[] {
  return message.parts
    .filter((part): part is A2AFilePart => part.kind === 'file')
    .map((part) => {
      const file = isRecord(part.file) ? part.file : {};
      return {
        name: typeof file.name === 'string' ? file.name : undefined,
        mimeType: typeof file.mimeType === 'string' ? file.mimeType : undefined,
        bytes: typeof file.bytes === 'string' ? file.bytes : undefined,
        uri: typeof file.uri === 'string' ? file.uri : undefined,
      };
    });
}

function extractHandoffContext(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const metadata = params?.metadata;
  if (!isRecord(metadata)) {
    return undefined;
  }

  const context = metadata.context;
  return isRecord(context) ? context : undefined;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as unknown;
  if (!isRecord(body)) {
    return NextResponse.json(createError(null, -32700, 'Invalid JSON payload'), { status: 400 });
  }

  const rpcRequest = body as unknown as A2AJsonRpcRequest;
  const rpcId = rpcRequest.id ?? null;

  if (rpcRequest.method !== 'message/send') {
    return NextResponse.json(
      createError(rpcId, -32601, `Method not found: ${String(rpcRequest.method)}`),
      { status: 404 },
    );
  }

  const params = isRecord(rpcRequest.params) ? rpcRequest.params : undefined;
  const message = extractMessage(params);
  if (!message) {
    return NextResponse.json(
      createError(rpcId, -32602, 'message/send requires params.message with message parts'),
      { status: 400 },
    );
  }

  const conversationId = message.contextId || `ctx-${randomUUID()}`;
  const history = extractHistory(message);
  const currentText = extractCurrentText(message);
  const inboundAttachments = extractAttachments(message);
  const handoffContext = extractHandoffContext(params);

  try {
    const responseText = await runHostedBridgeAgent({
      conversationId,
      currentText,
      history,
      handoffContext,
      inboundAttachments,
    });

    const resultMessage = {
      kind: 'message' as const,
      messageId: `resp-${randomUUID()}`,
      role: 'agent' as const,
      contextId: conversationId,
      parts: [
        {
          kind: 'text' as const,
          text: responseText || 'I completed the step, but I do not have anything else to add yet.',
        },
      ],
    };

    return NextResponse.json(createSuccess(rpcId, resultMessage));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Hosted bridge agent turn failed', {
      error: errorMessage,
      conversationId,
    });
    return NextResponse.json(createError(rpcId, -32000, errorMessage), { status: 500 });
  }
}
