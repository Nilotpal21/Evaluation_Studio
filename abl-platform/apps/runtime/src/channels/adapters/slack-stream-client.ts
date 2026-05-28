/**
 * Slack Streaming API Client
 *
 * Wraps Slack's streaming message APIs for real-time response delivery:
 *   - chat.startStream  → Open a streaming message in a thread
 *   - chat.appendStream → Append markdown text to the open stream
 *   - chat.stopStream   → Close the stream with optional final blocks
 *
 * These are distinct from chat.postMessage — they allow incremental text
 * delivery so users see tokens as they arrive from the LLM.
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('slack-stream-client');

const SLACK_BASE_URL = 'https://slack.com/api';
const SLACK_API_TIMEOUT_MS = 10_000;

function resolveSlackApiBase(apiBase?: string): string {
  const candidate = (apiBase || process.env.SLACK_API_BASE_URL || '').trim();
  if (!candidate) {
    return SLACK_BASE_URL;
  }

  try {
    return new URL(candidate).toString().replace(/\/+$/, '');
  } catch {
    return SLACK_BASE_URL;
  }
}

export interface SlackStreamResponse {
  ok: boolean;
  ts?: string;
  error?: string;
}

async function slackPost(
  endpoint: string,
  botToken: string,
  body: Record<string, unknown>,
  apiBase?: string,
): Promise<SlackStreamResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_API_TIMEOUT_MS);

  try {
    const response = await fetch(`${resolveSlackApiBase(apiBase)}/${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      log.error(`Slack ${endpoint} HTTP error`, { status: response.status });
      return { ok: false, error: `http_${response.status}` };
    }

    const result = (await response.json()) as SlackStreamResponse;
    if (!result.ok) {
      log.error(`Slack ${endpoint} failed`, { error: result.error });
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Open a streaming message in a Slack thread.
 * Returns the message `ts` used to identify the stream for append/stop calls.
 */
export async function startStream(
  botToken: string,
  channel: string,
  threadTs: string,
  options?: { teamId?: string; userId?: string; apiBase?: string },
): Promise<SlackStreamResponse> {
  const body: Record<string, unknown> = {
    channel,
    thread_ts: threadTs,
  };
  if (options?.teamId) {
    body.recipient_team_id = options.teamId;
  }
  if (options?.userId) {
    body.recipient_user_id = options.userId;
  }
  return slackPost('chat.startStream', botToken, body, options?.apiBase);
}

/**
 * Append markdown text to an open streaming message.
 */
export async function appendStream(
  botToken: string,
  channel: string,
  messageTs: string,
  markdownText: string,
  options?: { apiBase?: string },
): Promise<SlackStreamResponse> {
  return slackPost(
    'chat.appendStream',
    botToken,
    {
      channel,
      ts: messageTs,
      markdown_text: markdownText,
    },
    options?.apiBase,
  );
}

/**
 * Close a streaming message. Optionally append final text and/or rich blocks
 * (sources, action buttons, etc.) that appear below the streamed content.
 */
export async function stopStream(
  botToken: string,
  channel: string,
  messageTs: string,
  options?: { markdownText?: string; blocks?: unknown[]; apiBase?: string },
): Promise<SlackStreamResponse> {
  const body: Record<string, unknown> = {
    channel,
    ts: messageTs,
  };
  if (options?.markdownText) {
    body.markdown_text = options.markdownText;
  }
  if (options?.blocks && options.blocks.length > 0) {
    body.blocks = options.blocks;
  }
  return slackPost('chat.stopStream', botToken, body, options?.apiBase);
}
