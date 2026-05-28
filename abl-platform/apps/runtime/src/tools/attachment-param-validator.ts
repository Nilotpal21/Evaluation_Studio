/**
 * Attachment Parameter Validator
 *
 * Validates that a tool parameter value of `type: attachment` is a valid
 * attachment ID that exists in the current session. Called before tool dispatch
 * when a parameter has `format: 'attachment-id'` in the JSON Schema.
 */

import type { AttachmentServiceClient } from './attachment-tool-executor.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AttachmentValidationContext {
  serviceClient: AttachmentServiceClient;
  tenantId: string;
  sessionId: string;
}

export type AttachmentValidationResult = { valid: true } | { valid: false; error: string };

// ─── Validator ───────────────────────────────────────────────────────────────

/**
 * Validate that an attachment ID exists and belongs to the current session.
 *
 * Returns `{ valid: true }` if the attachment exists and belongs to the session,
 * or `{ valid: false, error }` with a helpful message otherwise.
 */
export async function validateAttachmentParam(
  attachmentId: string,
  ctx: AttachmentValidationContext,
): Promise<AttachmentValidationResult> {
  if (!attachmentId || attachmentId.trim().length === 0) {
    return {
      valid: false,
      error: `Invalid attachment ID: "${attachmentId}". Use list_attachments to see available files.`,
    };
  }

  const attachment = await ctx.serviceClient.getAttachment(attachmentId, ctx.tenantId);

  if (!attachment) {
    return {
      valid: false,
      error: `Invalid attachment ID: ${attachmentId}. Use list_attachments to see available files.`,
    };
  }

  // Verify the attachment belongs to the current session
  if (attachment.sessionId !== ctx.sessionId) {
    return {
      valid: false,
      error: `Invalid attachment ID: ${attachmentId}. Use list_attachments to see available files.`,
    };
  }

  return { valid: true };
}
