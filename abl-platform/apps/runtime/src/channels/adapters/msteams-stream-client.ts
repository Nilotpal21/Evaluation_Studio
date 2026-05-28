/**
 * MS Teams Streaming API Client
 *
 * Wraps the Teams Bot Framework REST API for streaming responses:
 *   - startStream     → Open a streaming message (typing activity with streaminfo)
 *   - continueStream  → Append text to the open stream (typing + streamSequence)
 *   - finalizeStream  → Close the stream with a final message activity
 *
 * These allow incremental text delivery so Teams users see tokens as they
 * arrive from the LLM, using the Bot Framework streaming protocol.
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('msteams-stream-client');

const TEAMS_API_TIMEOUT_MS = 10_000;

export type TeamsStreamType = 'informative' | 'streaming';

/**
 * Build the Bot Framework activity URL, ensuring no trailing-slash duplication.
 */
function activityUrl(serviceUrl: string, conversationId: string, activityId: string): string {
  const base = serviceUrl.replace(/\/+$/, '');
  return `${base}/v3/conversations/${conversationId}/activities/${activityId}`;
}

/**
 * Internal helper — POST an activity to the Bot Framework REST API.
 *
 * Unlike the Slack client (which returns { ok: false, error }), this throws
 * on non-2xx responses because the Bot Framework API has no application-level
 * error envelope.
 */
async function teamsPost(
  url: string,
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEAMS_API_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      log.error('Teams streaming API error', { status: response.status, url });
      throw new Error(`Teams streaming API error: ${response.status}`);
    }

    return response;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      log.error('Teams streaming API timeout', { endpoint: url });
      throw new Error(`Teams streaming API timeout after ${TEAMS_API_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Open a streaming message in a Teams conversation.
 * POSTs a `typing` activity with a `streaminfo` entity (streamSequence: 1).
 * Returns the `streamId` from the 201 response.
 */
export async function startStream(
  token: string,
  serviceUrl: string,
  conversationId: string,
  activityId: string,
  text: string,
  streamType: TeamsStreamType,
): Promise<{ streamId: string }> {
  const url = activityUrl(serviceUrl, conversationId, activityId);
  const response = await teamsPost(url, token, {
    type: 'typing',
    text,
    entities: [{ type: 'streaminfo', streamType, streamSequence: 1 }],
  });

  const result = (await response.json()) as { id: string };
  return { streamId: result.id };
}

/**
 * Append text to an open streaming message.
 * POSTs a `typing` activity with the given `streamId` and `streamSequence`.
 */
export async function continueStream(
  token: string,
  serviceUrl: string,
  conversationId: string,
  activityId: string,
  streamId: string,
  text: string,
  streamType: TeamsStreamType,
  streamSequence: number,
): Promise<void> {
  const url = activityUrl(serviceUrl, conversationId, activityId);
  await teamsPost(url, token, {
    type: 'typing',
    text,
    entities: [{ type: 'streaminfo', streamId, streamType, streamSequence }],
  });
}

/**
 * Close a streaming message with a final `message` activity.
 * Sets `streamType: "final"` with no `streamSequence`.
 * Optionally includes attachments (adaptive cards, etc.).
 */
export async function finalizeStream(
  token: string,
  serviceUrl: string,
  conversationId: string,
  activityId: string,
  streamId: string,
  text: string,
  attachments?: unknown[],
): Promise<void> {
  const url = activityUrl(serviceUrl, conversationId, activityId);
  const body: Record<string, unknown> = {
    type: 'message',
    text,
    entities: [{ type: 'streaminfo', streamId, streamType: 'final' }],
  };
  if (attachments && attachments.length > 0) {
    body.attachments = attachments;
  }
  await teamsPost(url, token, body);
}
