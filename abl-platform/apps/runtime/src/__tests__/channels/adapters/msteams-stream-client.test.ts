/**
 * MS Teams Stream Client Tests
 *
 * Verifies that startStream, continueStream, finalizeStream call the correct
 * Bot Framework REST API endpoints with the right headers, body, and entities.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  startStream,
  continueStream,
  finalizeStream,
} from '../../../channels/adapters/msteams-stream-client.js';

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const TOKEN = 'test-bearer-token';
const SERVICE_URL = 'https://smba.trafficmanager.net/teams';
const CONVERSATION_ID = 'conv-123';
const ACTIVITY_ID = 'act-456';
const STREAM_ID = 'stream-789';

function expectedUrl(serviceUrl = SERVICE_URL) {
  return `${serviceUrl}/v3/conversations/${CONVERSATION_ID}/activities/${ACTIVITY_ID}`;
}

function mock201Response(id: string) {
  return {
    ok: true,
    status: 201,
    json: async () => ({ id }),
  };
}

function mock202Response() {
  return {
    ok: true,
    status: 202,
    json: async () => ({}),
  };
}

function mockErrorResponse(status: number) {
  return {
    ok: false,
    status,
    json: async () => ({ error: 'forbidden' }),
  };
}

describe('startStream', () => {
  it('POSTs a typing activity with correct URL, method, headers, body, and entities', async () => {
    mockFetch.mockResolvedValueOnce(mock201Response(STREAM_ID));

    const result = await startStream(
      TOKEN,
      SERVICE_URL,
      CONVERSATION_ID,
      ACTIVITY_ID,
      'Thinking...',
      'informative',
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(expectedUrl());
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body);
    expect(body.type).toBe('typing');
    expect(body.text).toBe('Thinking...');
    expect(body.entities).toEqual([
      { type: 'streaminfo', streamType: 'informative', streamSequence: 1 },
    ]);

    expect(result).toEqual({ streamId: STREAM_ID });
  });

  it('throws on non-ok response (403)', async () => {
    mockFetch.mockResolvedValueOnce(mockErrorResponse(403));

    await expect(
      startStream(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID, 'Thinking...', 'streaming'),
    ).rejects.toThrow('Teams streaming API error: 403');
  });
});

describe('continueStream', () => {
  it('POSTs a typing activity with streamId and sequence', async () => {
    mockFetch.mockResolvedValueOnce(mock202Response());

    await continueStream(
      TOKEN,
      SERVICE_URL,
      CONVERSATION_ID,
      ACTIVITY_ID,
      STREAM_ID,
      'partial text...',
      'streaming',
      5,
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(expectedUrl());
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body);
    expect(body.type).toBe('typing');
    expect(body.text).toBe('partial text...');
    expect(body.entities).toEqual([
      { type: 'streaminfo', streamId: STREAM_ID, streamType: 'streaming', streamSequence: 5 },
    ]);
  });

  it('throws on non-ok response (429)', async () => {
    mockFetch.mockResolvedValueOnce(mockErrorResponse(429));

    await expect(
      continueStream(
        TOKEN,
        SERVICE_URL,
        CONVERSATION_ID,
        ACTIVITY_ID,
        STREAM_ID,
        'text',
        'streaming',
        2,
      ),
    ).rejects.toThrow('Teams streaming API error: 429');
  });
});

describe('finalizeStream', () => {
  it('POSTs a message activity with streamType final and no streamSequence', async () => {
    mockFetch.mockResolvedValueOnce(mock202Response());

    await finalizeStream(
      TOKEN,
      SERVICE_URL,
      CONVERSATION_ID,
      ACTIVITY_ID,
      STREAM_ID,
      'Final response text.',
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(expectedUrl());
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body);
    expect(body.type).toBe('message');
    expect(body.text).toBe('Final response text.');
    expect(body.entities).toEqual([
      { type: 'streaminfo', streamId: STREAM_ID, streamType: 'final' },
    ]);
    // Ensure no streamSequence on final
    expect(body.entities[0]).not.toHaveProperty('streamSequence');
  });

  it('includes attachments when provided', async () => {
    mockFetch.mockResolvedValueOnce(mock202Response());

    const attachments = [
      { contentType: 'application/vnd.microsoft.card.adaptive', content: { body: [] } },
    ];

    await finalizeStream(
      TOKEN,
      SERVICE_URL,
      CONVERSATION_ID,
      ACTIVITY_ID,
      STREAM_ID,
      'Done.',
      attachments,
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.attachments).toEqual(attachments);
  });

  it('omits attachments when not provided', async () => {
    mockFetch.mockResolvedValueOnce(mock202Response());

    await finalizeStream(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID, STREAM_ID, 'Done.');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('attachments');
  });

  it('omits attachments when an empty array is provided', async () => {
    mockFetch.mockResolvedValueOnce(mock202Response());

    await finalizeStream(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID, STREAM_ID, 'Done.', []);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('attachments');
  });
});

describe('teamsPost timeout handling', () => {
  it('throws a clear timeout error when the request is aborted', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    mockFetch.mockRejectedValueOnce(abortError);

    await expect(
      startStream(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID, 'Thinking...', 'streaming'),
    ).rejects.toThrow('Teams streaming API timeout after 10000ms');
  });
});
