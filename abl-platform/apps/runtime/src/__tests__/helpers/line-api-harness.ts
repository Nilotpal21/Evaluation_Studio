import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

interface LineApiRequest<TBody extends Record<string, unknown>> {
  token: string | null;
  body: TBody;
}

interface LineReplyCall extends LineApiRequest<Record<string, unknown>> {}

interface LinePushCall extends LineApiRequest<Record<string, unknown>> {}

interface LineTypingIndicatorCall extends LineApiRequest<Record<string, unknown>> {}

interface LineContentDownload {
  messageId: string;
  token: string | null;
}

interface RegisteredLineContent {
  mimeType: string;
  content: Buffer;
  requiredToken?: string;
}

export interface LineApiHarness {
  baseUrl: string;
  dataBaseUrl: string;
  reset(): void;
  registerContent(
    messageId: string,
    file: Omit<RegisteredLineContent, 'content'> & { content: string | Buffer },
  ): void;
  invalidateReplyToken(replyToken: string): void;
  getReplyCalls(): LineReplyCall[];
  getPushCalls(): LinePushCall[];
  getTypingIndicators(): LineTypingIndicatorCall[];
  getContentDownloads(): LineContentDownload[];
  close(): Promise<void>;
}

function parseBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startLineApiHarness(): Promise<LineApiHarness> {
  const replyCalls: LineReplyCall[] = [];
  const pushCalls: LinePushCall[] = [];
  const typingIndicators: LineTypingIndicatorCall[] = [];
  const contentDownloads: LineContentDownload[] = [];
  const contents = new Map<string, RegisteredLineContent>();
  const invalidReplyTokens = new Set<string>();

  const app = express();
  app.use(express.json());

  app.post('/v2/bot/message/reply', (req, res) => {
    const token = parseBearerToken(req.header('authorization'));
    const body = req.body as Record<string, unknown>;
    replyCalls.push({ token, body });

    const replyToken = typeof body.replyToken === 'string' ? body.replyToken : null;
    if (replyToken && invalidReplyTokens.has(replyToken)) {
      res.status(400).json({ message: 'Invalid reply token' });
      return;
    }

    res.status(200).json({});
  });

  app.post('/v2/bot/message/push', (req, res) => {
    const token = parseBearerToken(req.header('authorization'));
    pushCalls.push({
      token,
      body: req.body as Record<string, unknown>,
    });
    res.status(200).json({});
  });

  app.post('/v2/bot/chat/loading/start', (req, res) => {
    const token = parseBearerToken(req.header('authorization'));
    typingIndicators.push({
      token,
      body: req.body as Record<string, unknown>,
    });
    res.status(200).json({});
  });

  app.get('/v2/bot/message/:messageId/content', (req, res) => {
    const token = parseBearerToken(req.header('authorization'));
    const messageId = req.params.messageId;
    const content = contents.get(messageId);

    contentDownloads.push({ messageId, token });

    if (!content) {
      res.status(404).end();
      return;
    }

    if (content.requiredToken && token !== content.requiredToken) {
      res.status(401).end();
      return;
    }

    res.setHeader('Content-Type', content.mimeType);
    res.setHeader('Content-Length', String(content.content.length));
    res.end(content.content);
  });

  const server = await new Promise<http.Server>((resolve) => {
    const candidate = http.createServer(app);
    candidate.listen(0, '127.0.0.1', () => resolve(candidate));
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    dataBaseUrl: baseUrl,
    reset() {
      replyCalls.length = 0;
      pushCalls.length = 0;
      typingIndicators.length = 0;
      contentDownloads.length = 0;
      contents.clear();
      invalidReplyTokens.clear();
    },
    registerContent(messageId, file) {
      contents.set(messageId, {
        ...file,
        content: Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8'),
      });
    },
    invalidateReplyToken(replyToken) {
      invalidReplyTokens.add(replyToken);
    },
    getReplyCalls() {
      return replyCalls.slice();
    },
    getPushCalls() {
      return pushCalls.slice();
    },
    getTypingIndicators() {
      return typingIndicators.slice();
    },
    getContentDownloads() {
      return contentDownloads.slice();
    },
    async close() {
      await closeServer(server);
    },
  };
}
