export type AttachmentTraceCallback = (event: {
  type: 'attachment_process' | 'attachment_upload';
  data: Record<string, unknown>;
}) => void;

interface AttachmentTraceOptions {
  onTraceEvent?: AttachmentTraceCallback;
  type: 'attachment_process' | 'attachment_upload';
  channel: string;
  provider?: string;
  stage: string;
  success: boolean;
  attachmentId?: string;
  externalAttachmentId?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  durationMs?: number;
  error?: unknown;
}

export function formatAttachmentTraceError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object') {
    const message =
      'message' in error && typeof error.message === 'string' ? error.message : undefined;
    if (message) {
      return message;
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

export function emitAttachmentTrace(options: AttachmentTraceOptions): void {
  if (!options.onTraceEvent) {
    return;
  }

  options.onTraceEvent({
    type: options.type,
    data: {
      channel: options.channel,
      provider: options.provider || options.channel,
      stage: options.stage,
      success: options.success,
      source: 'channel_adapter',
      attachmentCount: 1,
      ...(options.attachmentId && { attachmentId: options.attachmentId }),
      ...(options.externalAttachmentId && {
        externalAttachmentId: options.externalAttachmentId,
      }),
      ...(options.filename && { filename: options.filename }),
      ...(options.mimeType && { mimeType: options.mimeType }),
      ...(typeof options.sizeBytes === 'number' && { sizeBytes: options.sizeBytes }),
      ...(typeof options.durationMs === 'number' && { durationMs: options.durationMs }),
      ...(options.error !== undefined && {
        error: formatAttachmentTraceError(options.error),
      }),
    },
  });
}
