import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

interface TwilioSentMessage {
  accountSid: string;
  authorization: string | null;
  body: Record<string, string>;
  sid: string;
}

interface TwilioMediaDownload {
  accountSid: string;
  messageSid: string;
  mediaSid: string;
  authorization: string | null;
}

interface RegisteredTwilioMedia {
  accountSid: string;
  messageSid: string;
  mediaSid: string;
  contentType: string;
  content: Buffer;
}

export interface TwilioApiHarness {
  baseUrl: string;
  apiBaseUrl: string;
  reset(): void;
  registerAccount(accountSid: string, authToken: string): void;
  registerMedia(media: Omit<RegisteredTwilioMedia, 'content'> & { content: string | Buffer }): void;
  getMediaUrl(accountSid: string, messageSid: string, mediaSid: string): string;
  getSentMessages(): TwilioSentMessage[];
  getMediaDownloads(): TwilioMediaDownload[];
  close(): Promise<void>;
}

function buildBasicAuthorization(accountSid: string, authToken: string): string {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
}

function mediaKey(accountSid: string, messageSid: string, mediaSid: string): string {
  return `${accountSid}:${messageSid}:${mediaSid}`;
}

function nextMessageSid(counter: number): string {
  return `SM${String(counter).padStart(32, '0')}`;
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

export async function startTwilioApiHarness(): Promise<TwilioApiHarness> {
  const sentMessages: TwilioSentMessage[] = [];
  const mediaDownloads: TwilioMediaDownload[] = [];
  const registeredAccounts = new Map<string, string>();
  const media = new Map<string, RegisteredTwilioMedia>();
  let nextSidCounter = 1;

  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.post('/2010-04-01/Accounts/:accountSid/Messages.json', (req, res) => {
    const accountSid = req.params.accountSid;
    const authorization = req.header('authorization') ?? null;
    const expectedAuthorization = registeredAccounts.get(accountSid);

    if (expectedAuthorization && authorization !== expectedAuthorization) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    const sid = nextMessageSid(nextSidCounter++);
    sentMessages.push({
      accountSid,
      authorization,
      body: Object.fromEntries(
        Object.entries(req.body as Record<string, string | string[]>).map(([key, value]) => [
          key,
          Array.isArray(value) ? (value[value.length - 1] ?? '') : value,
        ]),
      ),
      sid,
    });

    res.json({
      sid,
      status: 'queued',
    });
  });

  app.get('/2010-04-01/Accounts/:accountSid/Messages/:messageSid/Media/:mediaSid', (req, res) => {
    const { accountSid, messageSid, mediaSid } = req.params;
    const authorization = req.header('authorization') ?? null;
    const expectedAuthorization = registeredAccounts.get(accountSid);

    mediaDownloads.push({
      accountSid,
      messageSid,
      mediaSid,
      authorization,
    });

    if (expectedAuthorization && authorization !== expectedAuthorization) {
      res.status(401).end();
      return;
    }

    const file = media.get(mediaKey(accountSid, messageSid, mediaSid));
    if (!file) {
      res.status(404).end();
      return;
    }

    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(file.content.length));
    res.end(file.content);
  });

  const server = await new Promise<http.Server>((resolve) => {
    const candidate = http.createServer(app);
    candidate.listen(0, '127.0.0.1', () => resolve(candidate));
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const apiBaseUrl = `${baseUrl}/2010-04-01`;

  return {
    baseUrl,
    apiBaseUrl,
    reset() {
      sentMessages.length = 0;
      mediaDownloads.length = 0;
      registeredAccounts.clear();
      media.clear();
      nextSidCounter = 1;
    },
    registerAccount(accountSid, authToken) {
      registeredAccounts.set(accountSid, buildBasicAuthorization(accountSid, authToken));
    },
    registerMedia(file) {
      media.set(mediaKey(file.accountSid, file.messageSid, file.mediaSid), {
        ...file,
        content: Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8'),
      });
    },
    getMediaUrl(accountSid, messageSid, mediaSid) {
      return `${apiBaseUrl}/Accounts/${encodeURIComponent(accountSid)}/Messages/${encodeURIComponent(messageSid)}/Media/${encodeURIComponent(mediaSid)}`;
    },
    getSentMessages() {
      return sentMessages.slice();
    },
    getMediaDownloads() {
      return mediaDownloads.slice();
    },
    async close() {
      await closeServer(server);
    },
  };
}
