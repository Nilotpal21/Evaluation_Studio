import { describe, expect, it, vi } from 'vitest';
import {
  emitAttachmentTrace,
  formatAttachmentTraceError,
} from '../../../channels/adapters/attachment-trace-utils.js';

describe('attachment trace utilities', () => {
  it('emits attachment trace metadata without storage-provider internals', () => {
    const onTraceEvent = vi.fn();

    emitAttachmentTrace({
      onTraceEvent,
      type: 'attachment_process',
      channel: 'slack',
      provider: 'slack',
      stage: 'download',
      success: true,
      attachmentId: 'att-1',
      externalAttachmentId: 'slack-file-1',
      filename: 'image.png',
      mimeType: 'image/png',
      sizeBytes: 2048,
      durationMs: 42,
    });

    expect(onTraceEvent).toHaveBeenCalledWith({
      type: 'attachment_process',
      data: {
        channel: 'slack',
        provider: 'slack',
        stage: 'download',
        success: true,
        source: 'channel_adapter',
        attachmentCount: 1,
        attachmentId: 'att-1',
        externalAttachmentId: 'slack-file-1',
        filename: 'image.png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        durationMs: 42,
      },
    });
    expect(onTraceEvent.mock.calls[0][0].data).not.toHaveProperty('storageKey');
    expect(onTraceEvent.mock.calls[0][0].data).not.toHaveProperty('storageBucket');
  });

  it('normalizes object errors into readback-safe trace text', () => {
    expect(formatAttachmentTraceError({ code: 'MEDIA_DOWNLOAD_FAILED', retryable: true })).toBe(
      '{"code":"MEDIA_DOWNLOAD_FAILED","retryable":true}',
    );
  });
});
