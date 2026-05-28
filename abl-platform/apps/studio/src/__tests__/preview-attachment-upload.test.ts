import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolvePreviewRuntimeApiBaseUrl,
  uploadPreviewAttachment,
} from '@/components/preview/preview-attachment-upload';

describe('preview-attachment-upload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prefers explicit runtimeUrl when provided', () => {
    expect(
      resolvePreviewRuntimeApiBaseUrl({
        runtimeUrl: 'https://runtime.example.com/',
        sdkWsUrl: 'wss://ignored.example.com/ws/sdk',
      }),
    ).toBe('https://runtime.example.com');
  });

  it('derives runtime api base url from sdk websocket url', () => {
    expect(
      resolvePreviewRuntimeApiBaseUrl({
        sdkWsUrl: 'wss://runtime.example.com/ws/sdk',
      }),
    ).toBe('https://runtime.example.com');
  });

  it('uploads attachments with X-SDK-Token auth and returns attachmentId', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ attachmentId: 'att-123' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const attachmentId = await uploadPreviewAttachment({
      file: new File(['hello'], 'notes.txt', { type: 'text/plain' }),
      projectId: 'proj-1',
      sessionId: 'session-1',
      sdkToken: 'sdk-token',
      sdkWsUrl: 'wss://runtime.example.com/ws/sdk',
    });

    expect(attachmentId).toBe('att-123');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://runtime.example.com/api/projects/proj-1/sessions/session-1/attachments',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'X-SDK-Token': 'sdk-token',
        },
      }),
    );
  });
});
