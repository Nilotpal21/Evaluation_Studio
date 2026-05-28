import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import os from 'os';
import { mkdtemp, rm } from 'fs/promises';
import express from 'express';
import { createAttachmentRouter } from '../../../../multimodal-service/src/routes/attachments.js';
import { AttachmentService } from '../../../../multimodal-service/src/services/multimodal-service.js';
import { createStorageProvider } from '../../../../multimodal-service/src/storage/storage-factory.js';

export interface MultimodalServiceHarness {
  baseUrl: string;
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

export async function startMultimodalServiceHarness(): Promise<MultimodalServiceHarness> {
  const storageBasePath = await mkdtemp(path.join(os.tmpdir(), 'abl-mm-'));
  const storageProvider = createStorageProvider({
    provider: 'local',
    bucket: 'attachments',
    basePath: storageBasePath,
  });

  const attachmentService = new AttachmentService({
    storageProvider,
    scanQueue: {
      async add(): Promise<void> {
        // Tests exercise synchronous upload paths; async pipeline is optional when Redis is absent.
      },
    },
    storageBucket: 'attachments',
  });

  const app = express();
  app.use(express.json());
  app.use('/internal/attachments', createAttachmentRouter(attachmentService));

  const server = await new Promise<http.Server>((resolve) => {
    const candidate = http.createServer(app);
    candidate.listen(0, '127.0.0.1', () => resolve(candidate));
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    async close() {
      await closeServer(server);
      await rm(storageBasePath, { recursive: true, force: true });
    },
  };
}
