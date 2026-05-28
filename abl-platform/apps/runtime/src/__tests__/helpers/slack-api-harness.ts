import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

interface SlackApiRequest<TBody extends Record<string, unknown>> {
  token: string | null;
  body: TBody;
}

interface SlackPostedMessage extends SlackApiRequest<Record<string, unknown>> {
  ts: string;
}

interface SlackStreamStart extends SlackApiRequest<Record<string, unknown>> {
  ts: string;
}

interface SlackStreamAppend extends SlackApiRequest<Record<string, unknown>> {}

interface SlackStreamStop extends SlackApiRequest<Record<string, unknown>> {}

interface SlackFileDownload {
  fileId: string;
  token: string | null;
}

interface RegisteredSlackFile {
  filename: string;
  mimeType: string;
  content: Buffer;
  requiredToken?: string;
}

export interface SlackApiHarness {
  baseUrl: string;
  reset(): void;
  registerFile(
    fileId: string,
    file: Omit<RegisteredSlackFile, 'content'> & { content: string | Buffer },
  ): void;
  getFileUrl(fileId: string): string;
  getPostedMessages(): SlackPostedMessage[];
  getStreamStarts(): SlackStreamStart[];
  getStreamAppends(): SlackStreamAppend[];
  getStreamStops(): SlackStreamStop[];
  getFileDownloads(): SlackFileDownload[];
  close(): Promise<void>;
}

function parseBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function nextSlackTs(counter: number): string {
  return `1700000000.${String(counter).padStart(6, '0')}`;
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

export async function startSlackApiHarness(): Promise<SlackApiHarness> {
  const postedMessages: SlackPostedMessage[] = [];
  const streamStarts: SlackStreamStart[] = [];
  const streamAppends: SlackStreamAppend[] = [];
  const streamStops: SlackStreamStop[] = [];
  const fileDownloads: SlackFileDownload[] = [];
  const files = new Map<string, RegisteredSlackFile>();
  let nextTsCounter = 1;

  const app = express();
  app.use(express.json());

  app.post('/chat.postMessage', (req, res) => {
    const token = parseBearerToken(req.header('authorization'));
    const ts = nextSlackTs(nextTsCounter++);
    postedMessages.push({
      token,
      body: req.body as Record<string, unknown>,
      ts,
    });
    res.json({ ok: true, ts });
  });

  app.post('/chat.startStream', (req, res) => {
    const token = parseBearerToken(req.header('authorization'));
    const ts = nextSlackTs(nextTsCounter++);
    streamStarts.push({
      token,
      body: req.body as Record<string, unknown>,
      ts,
    });
    res.json({ ok: true, ts });
  });

  app.post('/chat.appendStream', (req, res) => {
    const token = parseBearerToken(req.header('authorization'));
    streamAppends.push({
      token,
      body: req.body as Record<string, unknown>,
    });
    res.json({ ok: true });
  });

  app.post('/chat.stopStream', (req, res) => {
    const token = parseBearerToken(req.header('authorization'));
    streamStops.push({
      token,
      body: req.body as Record<string, unknown>,
    });
    res.json({ ok: true });
  });

  app.get('/files/:fileId', (req, res) => {
    const token = parseBearerToken(req.header('authorization'));
    const fileId = req.params.fileId;
    const file = files.get(fileId);

    fileDownloads.push({ fileId, token });

    if (!file) {
      res.status(404).end();
      return;
    }

    if (file.requiredToken && token !== file.requiredToken) {
      res.status(401).setHeader('Content-Type', 'text/html');
      res.end('<html>unauthorized</html>');
      return;
    }

    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(file.content.length));
    res.end(file.content);
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
      postedMessages.length = 0;
      streamStarts.length = 0;
      streamAppends.length = 0;
      streamStops.length = 0;
      fileDownloads.length = 0;
      files.clear();
      nextTsCounter = 1;
    },
    registerFile(fileId, file) {
      files.set(fileId, {
        ...file,
        content: Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8'),
      });
    },
    getFileUrl(fileId) {
      return `${baseUrl}/files/${encodeURIComponent(fileId)}`;
    },
    getPostedMessages() {
      return postedMessages.slice();
    },
    getStreamStarts() {
      return streamStarts.slice();
    },
    getStreamAppends() {
      return streamAppends.slice();
    },
    getStreamStops() {
      return streamStops.slice();
    },
    getFileDownloads() {
      return fileDownloads.slice();
    },
    async close() {
      await closeServer(server);
    },
  };
}
