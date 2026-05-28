/**
 * Attachment event schemas.
 *
 * Events related to channel ingestion and runtime attachment preprocessing.
 */

import { z } from 'zod';
import { eventRegistry } from '../event-registry.js';
import { EVENT_CATEGORIES } from '../event-categories.js';

const AttachmentLifecycleDataSchema = z
  .object({
    channel: z.string().optional(),
    provider: z.string().optional(),
    stage: z.string().optional(),
    success: z.boolean().optional(),
    attachment_count: z.number().optional(),
    attachmentCount: z.number().optional(),
    attachment_id: z.string().optional(),
    attachmentId: z.string().optional(),
    external_attachment_id: z.string().optional(),
    externalAttachmentId: z.string().optional(),
    filename: z.string().optional(),
    mime_type: z.string().optional(),
    mimeType: z.string().optional(),
    size_bytes: z.number().optional(),
    sizeBytes: z.number().optional(),
    content_block_count: z.number().optional(),
    contentBlockCount: z.number().optional(),
    duration_ms: z.number().optional(),
    durationMs: z.number().optional(),
    error: z.string().optional(),
    source: z.string().optional(),
  })
  .passthrough();

eventRegistry.register('attachment.uploaded', AttachmentLifecycleDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.ATTACHMENT,
  containsPII: true,
  description: 'Attachment uploaded to downstream storage or preprocessing service',
});

eventRegistry.register('attachment.scanned', AttachmentLifecycleDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.ATTACHMENT,
  containsPII: true,
  description: 'Attachment scanned for validation or safety checks',
});

eventRegistry.register('attachment.processed', AttachmentLifecycleDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.ATTACHMENT,
  containsPII: true,
  description: 'Attachment processed during channel ingestion or normalization',
});

eventRegistry.register('attachment.indexed', AttachmentLifecycleDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.ATTACHMENT,
  containsPII: true,
  description: 'Attachment indexed for retrieval',
});

eventRegistry.register('attachment.deleted', AttachmentLifecycleDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.ATTACHMENT,
  containsPII: true,
  description: 'Attachment deleted from managed storage',
});

eventRegistry.register('attachment.preprocessed', AttachmentLifecycleDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.ATTACHMENT,
  containsPII: true,
  description: 'Attachment preprocessing completed before runtime execution',
});
