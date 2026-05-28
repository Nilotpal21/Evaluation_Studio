import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

interface TelegramWebhookRequest {
  token: string;
  body: {
    url: string;
    secret_token?: string;
    allowed_updates?: string[];
  };
}

interface TelegramDraftRequest {
  token: string;
  body: {
    chat_id: string | number;
    draft_id: number;
    text: string;
  };
}

interface TelegramMessageRequest {
  token: string;
  body: Record<string, unknown>;
}

interface TelegramChatActionRequest {
  token: string;
  body: {
    chat_id: string | number;
    action: string;
  };
}

interface TelegramCallbackAnswerRequest {
  token: string;
  body: {
    callback_query_id: string;
  };
}

interface RegisteredTelegramFile {
  filePath: string;
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface TelegramBotApiHarness {
  baseUrl: string;
  reset(): void;
  registerFile(
    fileId: string,
    file: Omit<RegisteredTelegramFile, 'content'> & { content: string | Buffer },
  ): void;
  getWebhookRequests(): TelegramWebhookRequest[];
  getWebhookSecret(token: string): string | null;
  getDraftRequests(): TelegramDraftRequest[];
  getSentMessages(): TelegramMessageRequest[];
  getTypingActions(): TelegramChatActionRequest[];
  getCallbackAnswers(): TelegramCallbackAnswerRequest[];
  close(): Promise<void>;
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

export async function startTelegramBotApiHarness(): Promise<TelegramBotApiHarness> {
  const webhookRequests: TelegramWebhookRequest[] = [];
  const draftRequests: TelegramDraftRequest[] = [];
  const sentMessages: TelegramMessageRequest[] = [];
  const typingActions: TelegramChatActionRequest[] = [];
  const callbackAnswers: TelegramCallbackAnswerRequest[] = [];
  const files = new Map<string, RegisteredTelegramFile>();
  const registeredTokens = new Set<string>();
  let nextMessageId = 1;

  const isAuthorizedToken = (token: string): boolean =>
    registeredTokens.size === 0 || registeredTokens.has(token);

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.all('*', (req, res) => {
    const pathname = req.path;

    const setWebhookMatch = pathname.match(/^\/bot([^/]+)\/setWebhook$/);
    if (req.method === 'POST' && setWebhookMatch) {
      registeredTokens.add(setWebhookMatch[1]);
      webhookRequests.push({
        token: setWebhookMatch[1],
        body: req.body as TelegramWebhookRequest['body'],
      });
      res.json({ ok: true, result: true });
      return;
    }

    const draftMatch = pathname.match(/^\/bot([^/]+)\/sendMessageDraft$/);
    if (req.method === 'POST' && draftMatch) {
      if (!isAuthorizedToken(draftMatch[1])) {
        res.status(401).json({ ok: false, description: 'Unauthorized bot token' });
        return;
      }

      draftRequests.push({
        token: draftMatch[1],
        body: req.body as TelegramDraftRequest['body'],
      });
      res.json({ ok: true, result: { draft_id: (req.body as { draft_id?: number }).draft_id } });
      return;
    }

    const sendMessageMatch = pathname.match(/^\/bot([^/]+)\/sendMessage$/);
    if (req.method === 'POST' && sendMessageMatch) {
      if (!isAuthorizedToken(sendMessageMatch[1])) {
        res.status(401).json({ ok: false, description: 'Unauthorized bot token' });
        return;
      }

      sentMessages.push({
        token: sendMessageMatch[1],
        body: req.body as Record<string, unknown>,
      });
      res.json({ ok: true, result: { message_id: nextMessageId++ } });
      return;
    }

    const sendChatActionMatch = pathname.match(/^\/bot([^/]+)\/sendChatAction$/);
    if (req.method === 'POST' && sendChatActionMatch) {
      if (!isAuthorizedToken(sendChatActionMatch[1])) {
        res.status(401).json({ ok: false, description: 'Unauthorized bot token' });
        return;
      }

      typingActions.push({
        token: sendChatActionMatch[1],
        body: req.body as TelegramChatActionRequest['body'],
      });
      res.json({ ok: true, result: true });
      return;
    }

    const answerCallbackMatch = pathname.match(/^\/bot([^/]+)\/answerCallbackQuery$/);
    if (req.method === 'POST' && answerCallbackMatch) {
      if (!isAuthorizedToken(answerCallbackMatch[1])) {
        res.status(401).json({ ok: false, description: 'Unauthorized bot token' });
        return;
      }

      callbackAnswers.push({
        token: answerCallbackMatch[1],
        body: req.body as TelegramCallbackAnswerRequest['body'],
      });
      res.json({ ok: true, result: true });
      return;
    }

    const getFileMatch = pathname.match(/^\/bot([^/]+)\/getFile$/);
    if (req.method === 'GET' && getFileMatch) {
      if (!isAuthorizedToken(getFileMatch[1])) {
        res.status(401).json({ ok: false, description: 'Unauthorized bot token' });
        return;
      }

      const fileId = req.query.file_id;
      if (typeof fileId !== 'string' || !files.has(fileId)) {
        res.status(404).json({ ok: false, description: 'File not found' });
        return;
      }

      const file = files.get(fileId)!;
      res.json({
        ok: true,
        result: {
          file_id: fileId,
          file_path: file.filePath,
          file_size: file.content.length,
        },
      });
      return;
    }

    const downloadMatch = pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);
    if (req.method === 'GET' && downloadMatch) {
      if (!isAuthorizedToken(downloadMatch[1])) {
        res.status(401).end();
        return;
      }

      const requestedPath = decodeURIComponent(downloadMatch[2]);
      const file = [...files.values()].find((candidate) => candidate.filePath === requestedPath);
      if (!file) {
        res.status(404).end();
        return;
      }

      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Content-Length', String(file.content.length));
      res.end(file.content);
      return;
    }

    res.status(404).json({ ok: false, description: 'Unsupported test Telegram API route' });
  });

  const server = await new Promise<http.Server>((resolve) => {
    const candidate = http.createServer(app);
    candidate.listen(0, '127.0.0.1', () => resolve(candidate));
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    reset() {
      webhookRequests.length = 0;
      draftRequests.length = 0;
      sentMessages.length = 0;
      typingActions.length = 0;
      callbackAnswers.length = 0;
      files.clear();
      registeredTokens.clear();
      nextMessageId = 1;
    },
    registerFile(fileId, file) {
      files.set(fileId, {
        ...file,
        content: Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8'),
      });
    },
    getWebhookRequests() {
      return webhookRequests.slice();
    },
    getWebhookSecret(token) {
      const match = webhookRequests.find((request) => request.token === token);
      return match?.body.secret_token ?? null;
    },
    getDraftRequests() {
      return draftRequests.slice();
    },
    getSentMessages() {
      return sentMessages.slice();
    },
    getTypingActions() {
      return typingActions.slice();
    },
    getCallbackAnswers() {
      return callbackAnswers.slice();
    },
    async close() {
      await closeServer(server);
    },
  };
}
