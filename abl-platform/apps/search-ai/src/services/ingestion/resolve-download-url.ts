/**
 * Resolve a downloadable URL for a document.
 *
 * Generates signed download URLs that any external API can use
 * to fetch the document, regardless of the storage backend (local, S3, EFS).
 *
 * The URL points to the SearchAI download endpoint which handles
 * S3 presigning, local file serving, etc.
 */

import {
  generateDownloadToken,
  generatePermanentDownloadToken,
  buildDownloadUrl,
} from '../../routes/document-download.js';

/**
 * Generate a short-lived downloadable HTTP URL for a document.
 * Used by extraction workers and other transient operations.
 *
 * @param documentId - The document ID
 * @param tenantId - The tenant ID
 * @returns An HTTP URL valid for 15 minutes
 */
export function resolveDownloadUrl(documentId: string, tenantId: string): string {
  const token = generateDownloadToken(documentId, tenantId);
  return buildDownloadUrl(documentId, token);
}

/**
 * Generate a permanent downloadable HTTP URL for a document.
 * Used for storing on the document record (design-time access, canonical metadata).
 * Runtime citations generate their own expiry-controlled tokens separately.
 *
 * @param documentId - The document ID
 * @param tenantId - The tenant ID
 * @returns An HTTP URL valid for 10 years
 */
export function resolvePermanentDownloadUrl(documentId: string, tenantId: string): string {
  const token = generatePermanentDownloadToken(documentId, tenantId);
  return buildDownloadUrl(documentId, token);
}
