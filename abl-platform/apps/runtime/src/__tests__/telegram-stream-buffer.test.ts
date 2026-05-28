import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramStreamBuffer } from '../channels/adapters/telegram-stream-buffer.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.stubGlobal('fetch', vi.fn());
const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;

const BOT_TOKEN = 'test-bot-token';
const CHAT_ID = 12345;
const DRAFT_ID = 99;
const API_BASE = 'https://api.telegram.org';

function okResponse() {
  return {
    ok: true,
    text: async () => 'ok',
  };
}

function errorResponse(status = 500) {
  return {
    ok: false,
    status,
    text: async () => 'internal server error',
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// Constructor and basic state
// ===========================================================================

describe('TelegramStreamBuffer – constructor and basic state', () => {
  it('isStarted is false initially', () => {
    const buf = new TelegramStreamBuffer(BOT_TOKEN, CHAT_ID, DRAFT_ID);
    expect(buf.isStarted).toBe(false);
  });

  it('accumulatedText is empty initially', () => {
    const buf = new TelegramStreamBuffer(BOT_TOKEN, CHAT_ID, DRAFT_ID);
    expect(buf.accumulatedText).toBe('');
  });
});

// ===========================================================================
// onChunk
// ===========================================================================

describe('TelegramStreamBuffer – onChunk', () => {
  it('small chunk below chunkSize does not trigger flush', async () => {
    const buf = new TelegramStreamBuffer(BOT_TOKEN, CHAT_ID, DRAFT_ID, { chunkSize: 100 });
    await buf.onChunk('hello');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('chunk exceeding chunkSize triggers flush via sendMessageDraft', async () => {
    vi.setSystemTime(1000);
    mockFetch.mockResolvedValueOnce(okResponse());

    const buf = new TelegramStreamBuffer(BOT_TOKEN, CHAT_ID, DRAFT_ID, { chunkSize: 5 });
    await buf.onChunk('abcdef'); // 6 chars > chunkSize 5

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`${API_BASE}/bot${BOT_TOKEN}/sendMessageDraft`);
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body);
    expect(body.chat_id).toBe(CHAT_ID);
    expect(body.draft_id).toBe(DRAFT_ID);
    expect(body.text).toBe('abcdef');
  });

  it('verify sendMessageDraft body contains accumulated full text', async () => {
    vi.setSystemTime(1000);
    mockFetch.mockResolvedValue(okResponse());

    const buf = new TelegramStreamBuffer(BOT_TOKEN, CHAT_ID, DRAFT_ID, { chunkSize: 3 });

    // First chunk flushes
    await buf.onChunk('aaaa');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    let body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text).toBe('aaaa');

    // Advance past throttle interval (lastFlushTime was set to ~1000)
    vi.setSystemTime(1500);

    // Second chunk – fullText should include both chunks
    await buf.onChunk('bbbb');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.text).toBe('aaaabbbb');
  });

  it('backpressure: while flush is in-flight, onChunk does not trigger another flush', async () => {
    vi.setSystemTime(1000);

    let resolveFlush!: (v: unknown) => void;
    const flushPromise = new Promise((r) => {
      resolveFlush = r;
    });
    mockFetch.mockReturnValueOnce(flushPromise);

    const buf = new TelegramStreamBuffer(BOT_TOKEN, CHAT_ID, DRAFT_ID, { chunkSize: 3 });

    // Start first flush (don't await – it's pending)
    const p1 = buf.onChunk('aaaa');

    // While flush is in-flight, send another large chunk
    await buf.onChunk('bbbb');

    // Only one fetch call should have been made
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Resolve the pending flush
    resolveFlush(okResponse());
    await p1;
  });

  it('throttle: rapid chunks within MIN_FLUSH_INTERVAL_MS do not trigger extra flushes', async () => {
    vi.setSystemTime(1000);
    mockFetch.mockResolvedValue(okResponse());

    const buf = new TelegramStreamBuffer(BOT_TOKEN, CHAT_ID, DRAFT_ID, { chunkSize: 3 });

    // First flush at time 1000
    await buf.onChunk('aaaa');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // At time 1100 (within 400ms throttle of lastFlushTime ~1000) – should NOT flush
    vi.setSystemTime(1100);
    await buf.onChunk('bbbb');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // At time 1500 (past throttle) – should flush
    vi.setSystemTime(1500);
    await buf.onChunk('cccc');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('partial citation at end of buffer prevents flush', async () => {
    vi.setSystemTime(1000);
    mockFetch.mockResolvedValue(okResponse());

    const buf = new TelegramStreamBuffer(BOT_TOKEN, CHAT_ID, DRAFT_ID, { chunkSize: 3 });

    // Buffer ends with partial citation "[doc"
    await buf.onChunk('hello world [doc');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// flush
// ===========================================================================

describe('TelegramStreamBuffer – flush', () => {
  it('on successful flush, isStarted becomes true', async () => {
    vi.setSystemTime(1000);
    mockFetch.mockResolvedValueOnce(okResponse());

    const buf = new TelegramStreamBuffer(BOT_TOKEN, CHAT_ID, DRAFT_ID, { chunkSize: 3 });
    expect(buf.isStarted).toBe(false);

    await buf.onChunk('abcdef');
    expect(buf.isStarted).toBe(true);
  });

  it('on API error (non-ok response), failed flag set, subsequent onChunk is no-op', async () => {
    vi.setSystemTime(1000);
    mockFetch.mockResolvedValueOnce(errorResponse(429));

    const buf = new TelegramStreamBuffer(BOT_TOKEN, CHAT_ID, DRAFT_ID, { chunkSize: 3 });
    await buf.onChunk('abcdef');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(buf.isStarted).toBe(false);

    // Subsequent onChunk should be a no-op
    mockFetch.mockClear();
    vi.setSystemTime(2000);
    await buf.onChunk('more text');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('on network error (fetch throws), failed flag set', async () => {
    vi.setSystemTime(1000);
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const buf = new TelegramStreamBuffer(BOT_TOKEN, CHAT_ID, DRAFT_ID, { chunkSize: 3 });
    await buf.onChunk('abcdef');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(buf.isStarted).toBe(false);

    // Subsequent onChunk should be a no-op
    mockFetch.mockClear();
    vi.setSystemTime(2000);
    await buf.onChunk('more text');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// close
// ===========================================================================

describe('TelegramStreamBuffer – close', () => {
  it('flushes remaining buffer on close', async () => {
    vi.setSystemTime(1000);
    mockFetch.mockResolvedValue(okResponse());

    const buf = new TelegramStreamBuffer(BOT_TOKEN, CHAT_ID, DRAFT_ID, { chunkSize: 100 });
    await buf.onChunk('hello');
    expect(mockFetch).not.toHaveBeenCalled();

    await buf.close();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text).toBe('hello');
  });

  it('after close, onChunk is no-op', async () => {
    vi.setSystemTime(1000);
    mockFetch.mockResolvedValue(okResponse());

    const buf = new TelegramStreamBuffer(BOT_TOKEN, CHAT_ID, DRAFT_ID, { chunkSize: 3 });
    await buf.close();

    mockFetch.mockClear();
    await buf.onChunk('abcdef');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('close when already closed is no-op', async () => {
    vi.setSystemTime(0);
    mockFetch.mockResolvedValue(okResponse());

    const buf = new TelegramStreamBuffer(BOT_TOKEN, CHAT_ID, DRAFT_ID, { chunkSize: 100 });
    await buf.onChunk('hello');

    await buf.close();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second close should not flush again
    await buf.close();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// settle
// ===========================================================================

describe('TelegramStreamBuffer – settle', () => {
  it('waits for pending request to complete', async () => {
    vi.useRealTimers();

    let resolveFlush!: (v: unknown) => void;
    const flushPromise = new Promise((r) => {
      resolveFlush = r;
    });
    mockFetch.mockReturnValueOnce(flushPromise);

    const buf = new TelegramStreamBuffer(BOT_TOKEN, CHAT_ID, DRAFT_ID, { chunkSize: 3 });

    // Start a flush but don't await it
    const chunkPromise = buf.onChunk('abcdef');

    // settle should wait for the in-flight request
    const settlePromise = buf.settle();

    // Resolve the fetch after a short delay
    setTimeout(() => resolveFlush(okResponse()), 100);

    await settlePromise;
    await chunkPromise;

    expect(buf.isStarted).toBe(true);
  });
});
