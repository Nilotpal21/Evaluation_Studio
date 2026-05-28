/**
 * Attachment file-writer factory.
 *
 * Encapsulates the per-tenant file-writer closure so it can be constructed
 * both in the main server startup (index.ts) and in tests without standing
 * up the full server.
 */

import {
  buildAttachmentKey,
  randomAttachmentId,
  type FileStorage,
} from '../storage/storage-factory.js';

/** Maximum attachment size enforced before writing to storage. */
export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

export type FileWriter = (fileName: string, data: Buffer, mimeType: string) => Promise<string>;

/**
 * Returns a factory `(tenantId) => FileWriter` that writes attachments to
 * `storage`, signs an HMAC token, and returns a public download URL.
 *
 * All uploads receive the `expiry-class=temporary-attachment` S3 object tag
 * so that S3/MinIO lifecycle policies can delete them after the retention window.
 * (Local storage is cleaned up by the attachment-cleanup sweep instead.)
 */
export function createFileWriterFactory(
  attachmentStorage: FileStorage,
  signToken: (key: string, tenantId: string) => string,
  publicUrl: string,
): (tenantId: string) => FileWriter {
  return (tenantId: string): FileWriter =>
    async (fileName: string, data: Buffer, mimeType: string): Promise<string> => {
      if (data.byteLength > ATTACHMENT_MAX_BYTES) {
        throw new Error(
          `Attachment exceeds the ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB limit (${data.byteLength} bytes)`,
        );
      }
      const attachmentId = randomAttachmentId();
      const key = buildAttachmentKey(tenantId, attachmentId, fileName);
      await attachmentStorage.upload(key, data, {
        contentType: mimeType,
        tagging: 'expiry-class=temporary-attachment',
      });
      const token = signToken(key, tenantId);
      const params = new URLSearchParams({ token, f: fileName, m: mimeType });
      return `${publicUrl}/attachments/${attachmentId}?${params.toString()}`;
    };
}
