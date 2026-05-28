'use client';

interface ResolvePreviewRuntimeApiBaseUrlParams {
  runtimeUrl?: string | null;
  sdkWsUrl?: string | null;
}

interface UploadPreviewAttachmentParams extends ResolvePreviewRuntimeApiBaseUrlParams {
  file: File;
  projectId: string;
  sessionId: string;
  sdkToken: string;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

export function resolvePreviewRuntimeApiBaseUrl({
  runtimeUrl,
  sdkWsUrl,
}: ResolvePreviewRuntimeApiBaseUrlParams): string {
  if (typeof runtimeUrl === 'string' && runtimeUrl.trim().length > 0) {
    return trimTrailingSlashes(runtimeUrl.trim());
  }

  if (typeof sdkWsUrl === 'string' && sdkWsUrl.trim().length > 0) {
    const parsed = new URL(sdkWsUrl.trim());
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    parsed.pathname = parsed.pathname.replace(/\/ws\/sdk$/, '').replace(/\/ws$/, '') || '/';
    parsed.search = '';
    parsed.hash = '';
    return trimTrailingSlashes(parsed.toString());
  }

  if (typeof window !== 'undefined') {
    return trimTrailingSlashes(window.location.origin);
  }

  throw new Error('Runtime URL is not available for attachment uploads');
}

export async function uploadPreviewAttachment({
  file,
  projectId,
  sessionId,
  sdkToken,
  runtimeUrl,
  sdkWsUrl,
}: UploadPreviewAttachmentParams): Promise<string> {
  const apiBaseUrl = resolvePreviewRuntimeApiBaseUrl({ runtimeUrl, sdkWsUrl });
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(
    `${apiBaseUrl}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/attachments`,
    {
      method: 'POST',
      body: formData,
      headers: {
        'X-SDK-Token': sdkToken,
      },
    },
  );

  if (!response.ok) {
    let message = `Attachment upload failed (${response.status})`;
    const jsonCandidate = response.clone();

    try {
      const body = (await jsonCandidate.json()) as
        | { error?: { message?: string } }
        | { message?: string }
        | undefined;
      const structuredMessage =
        body && 'error' in body && typeof body.error?.message === 'string'
          ? body.error.message
          : body && 'message' in body && typeof body.message === 'string'
            ? body.message
            : null;
      if (structuredMessage && structuredMessage.trim().length > 0) {
        message = structuredMessage;
      }
    } catch {
      try {
        const text = await response.text();
        if (text.trim().length > 0) {
          message = text;
        }
      } catch {
        // Fall back to the status-derived message.
      }
    }

    throw new Error(message);
  }

  const result = (await response.json()) as { attachmentId?: string };
  if (typeof result.attachmentId !== 'string' || result.attachmentId.trim().length === 0) {
    throw new Error('Attachment upload did not return an attachmentId');
  }

  return result.attachmentId;
}
