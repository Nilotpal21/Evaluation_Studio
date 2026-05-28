import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

const mockResolveOrpheusServiceConfig = vi.fn();

vi.mock('../../services/voice/orpheus-service-instance-resolver.js', () => ({
  resolveOrpheusServiceConfig: (...args: unknown[]) => mockResolveOrpheusServiceConfig(...args),
}));

import { OrpheusCustomTtsStreamingHandler } from '../../websocket/orpheus-custom-tts-handler.js';

class FakeWebSocket extends EventEmitter {
  public readyState = WebSocket.OPEN;
  public sent: Array<{ payload: Buffer; binary: boolean }> = [];
  public closedWith: { code?: number; reason?: Buffer } | null = null;

  send(
    data: string | Buffer | ArrayBuffer | Buffer[],
    options?: { binary?: boolean } | ((err?: Error) => void),
    callback?: (err?: Error) => void,
  ): void {
    const resolvedCallback = typeof options === 'function' ? options : callback;
    const binary = typeof options === 'function' ? false : options?.binary === true;
    const payload = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data.map((entry) => Buffer.from(entry)))
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.from(data);
    this.sent.push({ payload, binary });
    resolvedCallback?.();
  }

  close(code?: number, reason?: string): void {
    this.readyState = WebSocket.CLOSED;
    this.closedWith = {
      code,
      reason: reason ? Buffer.from(reason) : undefined,
    };
    this.emit('close');
  }
}

function makeRequest(
  url: string,
  token = 'route-token',
  authorization = `Bearer ${token}`,
): IncomingMessage & { headers: Record<string, string> } {
  return {
    url,
    headers: {
      host: 'runtime.example.com',
      authorization,
    },
  } as IncomingMessage & { headers: Record<string, string> };
}

describe('OrpheusCustomTtsStreamingHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ORPHEUS_TTS_AUTH_TOKEN = 'route-token';
    process.env.ORPHEUS_GROQ_API_KEY = 'groq-key';
    mockResolveOrpheusServiceConfig.mockResolvedValue({
      apiKey: 'groq-key',
      model: 'canopylabs/orpheus-v1-english',
      voice: 'austin',
      source: 'environment',
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('rejects websocket connections with an invalid bearer token', () => {
    const ws = new FakeWebSocket();
    const handler = new OrpheusCustomTtsStreamingHandler();

    handler.handleConnection(
      ws as unknown as WebSocket,
      makeRequest('/ws/custom-tts/orpheus', 'bad'),
    );

    expect(ws.closedWith?.code).toBe(1008);
  });

  it('accepts bearer auth even when the header omits the space after Bearer', () => {
    const ws = new FakeWebSocket();
    const handler = new OrpheusCustomTtsStreamingHandler();

    handler.handleConnection(
      ws as unknown as WebSocket,
      makeRequest('/ws/custom-tts/orpheus', 'route-token', 'Bearerroute-token'),
    );

    expect(ws.closedWith).toBeNull();
  });

  it('sends a connect ack and buffers stream commands until flush', async () => {
    const synthesizeStream = vi.fn(async function* () {
      yield {
        pcmData: Buffer.alloc(640, 7),
        sampleRate: 24000,
        bitsPerSample: 16,
        channels: 1,
        normalizedText: 'Hello there',
        chunks: ['Hello there'],
      };
    });
    const ws = new FakeWebSocket();
    const handler = new OrpheusCustomTtsStreamingHandler({ synthesizeStream });

    handler.handleConnection(
      ws as unknown as WebSocket,
      makeRequest('/ws/custom-tts/orpheus?voice=austin&language=en&sampleRate=8000'),
    );

    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));

    expect(JSON.parse(ws.sent[0].payload.toString('utf8'))).toEqual({
      type: 'connect',
      data: {
        sample_rate: 24000,
        base64_encoding: false,
      },
    });

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'stream', text: 'Hello ' })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'stream', text: 'there' })));
    ws.emit('message', Buffer.from(JSON.stringify({ command: 'flush' })));

    await vi.waitFor(() => expect(synthesizeStream).toHaveBeenCalledTimes(1));

    expect(synthesizeStream).toHaveBeenCalledWith({
      apiKey: 'groq-key',
      text: 'Hello there',
      voice: 'austin',
      model: expect.any(String),
    });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(1));

    const messages = ws.sent.slice(1);
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message.binary).toBe(true);
      expect(message.payload.length).toBeGreaterThan(0);
    }
  });

  it('drops buffered text on clear before flush', async () => {
    const synthesizeStream = vi.fn(async function* () {
      yield {
        pcmData: Buffer.alloc(320, 9),
        sampleRate: 24000,
        bitsPerSample: 16,
        channels: 1,
        normalizedText: 'should not happen',
        chunks: ['should not happen'],
      };
    });
    const ws = new FakeWebSocket();
    const handler = new OrpheusCustomTtsStreamingHandler({ synthesizeStream });

    handler.handleConnection(
      ws as unknown as WebSocket,
      makeRequest('/ws/custom-tts/orpheus?voice=austin&sampleRate=8000'),
    );

    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'stream', text: 'discard me' })));
    ws.emit('message', Buffer.from(JSON.stringify({ command: 'clear' })));
    ws.emit('message', Buffer.from(JSON.stringify({ command: 'flush' })));

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(synthesizeStream).not.toHaveBeenCalled();
    expect(ws.sent).toHaveLength(1);
  });
});
