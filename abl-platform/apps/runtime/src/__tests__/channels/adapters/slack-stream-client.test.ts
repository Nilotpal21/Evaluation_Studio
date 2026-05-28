/**
 * Slack Stream Client Tests
 *
 * Verifies that startStream, appendStream, stopStream call the correct
 * Slack API endpoints with the right headers and body.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  startStream,
  appendStream,
  stopStream,
} from '../../../channels/adapters/slack-stream-client.js';

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockOkResponse(ts?: string) {
  return {
    ok: true,
    json: async () => ({ ok: true, ts: ts ?? '1234567890.123456' }),
  };
}

function mockErrorResponse(error: string) {
  return {
    ok: true,
    json: async () => ({ ok: false, error }),
  };
}

describe('startStream', () => {
  it('POSTs to chat.startStream with correct params', async () => {
    mockFetch.mockResolvedValueOnce(mockOkResponse('111.222'));

    const result = await startStream('xoxb-token', 'C123', '1111.2222');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.startStream');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer xoxb-token');

    const body = JSON.parse(opts.body);
    expect(body.channel).toBe('C123');
    expect(body.thread_ts).toBe('1111.2222');

    expect(result).toEqual({ ok: true, ts: '111.222' });
  });

  it('returns error when Slack API fails', async () => {
    mockFetch.mockResolvedValueOnce(mockErrorResponse('channel_not_found'));

    const result = await startStream('xoxb-token', 'C999', '1111.2222');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('channel_not_found');
  });
});

describe('appendStream', () => {
  it('POSTs to chat.appendStream with markdown_text', async () => {
    mockFetch.mockResolvedValueOnce(mockOkResponse());

    const result = await appendStream('xoxb-token', 'C123', '111.222', 'Hello **world**');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.appendStream');

    const body = JSON.parse(opts.body);
    expect(body.channel).toBe('C123');
    expect(body.ts).toBe('111.222');
    expect(body.markdown_text).toBe('Hello **world**');

    expect(result.ok).toBe(true);
  });
});

describe('stopStream', () => {
  it('POSTs to chat.stopStream with ts', async () => {
    mockFetch.mockResolvedValueOnce(mockOkResponse());

    const result = await stopStream('xoxb-token', 'C123', '111.222');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.stopStream');

    const body = JSON.parse(opts.body);
    expect(body.channel).toBe('C123');
    expect(body.ts).toBe('111.222');
    expect(body).not.toHaveProperty('markdown_text');
    expect(body).not.toHaveProperty('blocks');

    expect(result.ok).toBe(true);
  });

  it('includes final text and blocks when provided', async () => {
    mockFetch.mockResolvedValueOnce(mockOkResponse());

    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'Sources: ...' } }];
    await stopStream('xoxb-token', 'C123', '111.222', {
      markdownText: 'final chunk',
      blocks,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.markdown_text).toBe('final chunk');
    expect(body.blocks).toEqual(blocks);
  });

  it('omits blocks when array is empty', async () => {
    mockFetch.mockResolvedValueOnce(mockOkResponse());

    await stopStream('xoxb-token', 'C123', '111.222', { blocks: [] });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('blocks');
  });
});
