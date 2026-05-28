/**
 * Shared document download utility
 *
 * Downloads document content from S3, HTTP, or local file URLs.
 * Extracted from docling-extraction-worker to be reusable by extraction-worker.
 */

import { S3StorageService } from '@agent-platform/shared';
import { safeFetch } from '@agent-platform/shared-kernel/security/safe-fetch';
import { getConfig } from '../../config/index.js';
import { workerLog } from '../../workers/shared.js';

/**
 * Download document content from S3, HTTP, or local file URL.
 * Returns the raw Buffer content.
 */
export async function downloadDocumentContent(url: string): Promise<Buffer> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const config = getConfig();

  if (url.startsWith('s3://')) {
    const withoutProtocol = url.substring('s3://'.length);
    const slashIdx = withoutProtocol.indexOf('/');
    const bucket = withoutProtocol.substring(0, slashIdx);
    const key = withoutProtocol.substring(slashIdx + 1);
    workerLog('download-document', `Downloading from S3: bucket=${bucket} key=${key}`);
    const s3 = new S3StorageService({
      bucket,
      region: config.storage.region || 'us-east-1',
      endpoint: config.storage.endpoint,
      accessKeyId: config.storage.accessKeyId,
      secretAccessKey: config.storage.secretAccessKey,
    });
    return s3.download(key);
  }

  if (url.startsWith('file://') || url.startsWith('/uploads/')) {
    let filePath: string;

    if (url.startsWith('file://')) {
      filePath = url.replace('file://', '');
    } else {
      const basePath = path.resolve(config.storage.basePath || './uploads');
      const relativePath = url.substring('/uploads/'.length);
      filePath = path.join(basePath, relativePath);
    }

    workerLog('download-document', `Reading from local file: ${filePath}`);
    return fs.readFile(filePath);
  }

  if (url.startsWith('http://') || url.startsWith('https://')) {
    workerLog('download-document', `Downloading from HTTP: ${url}`);
    const response = await safeFetch(
      url,
      {
        signal: AbortSignal.timeout(60_000),
      },
      {
        maxRedirects: 5,
      },
    );
    if (!response.ok) {
      throw new Error(`Failed to download document: HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  throw new Error(
    `Unsupported URL format: ${url}. Expected file://, /uploads/, s3://, or http(s)://`,
  );
}
