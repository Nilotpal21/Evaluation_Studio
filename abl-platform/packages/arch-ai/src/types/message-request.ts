/**
 * MessageRequest — Contract: api-index.md
 * Discriminated union on `type` field.
 */

import { z } from 'zod';
import { MESSAGE_LIMITS } from './constants.js';
import { PageContextSchema } from './page-context.js';

export const FileAttachmentSchema = z.object({
  name: z.string(),
  size: z.number(),
  type: z.string(),
  content: z.string(),
});

export type FileAttachment = z.infer<typeof FileAttachmentSchema>;

const MessagePayloadSchema = z.object({
  sessionId: z.string().min(1),
  type: z.literal('message'),
  text: z.string().max(MESSAGE_LIMITS.MAX_MESSAGE_LENGTH),
  files: z.array(FileAttachmentSchema).max(MESSAGE_LIMITS.MAX_FILES).optional(),
  fileRefs: z
    .array(
      z.object({
        blobId: z.string().min(1),
      }),
    )
    .max(MESSAGE_LIMITS.MAX_FILE_REFS)
    .optional(),
  pageContext: PageContextSchema.optional(),
});

export const MessageRequestSchema = z
  .discriminatedUnion('type', [
    MessagePayloadSchema,
    z.object({
      sessionId: z.string().min(1),
      type: z.literal('tool_answer'),
      toolCallId: z.string().min(1),
      answer: z.unknown(),
      secrets: z
        .object({
          flowId: z.string().min(1),
          values: z.record(z.string(), z.string()),
        })
        .optional(),
    }),
    z.object({
      sessionId: z.string().min(1),
      type: z.literal('gate_response'),
      action: z.enum(['accept', 'reject', 'modify']),
      feedback: z.string().optional(),
    }),
    z.object({
      sessionId: z.string().min(1),
      type: z.literal('proposal_response'),
      action: z.enum(['accept', 'modify', 'reject']),
      feedback: z.string().optional(),
    }),
    z.object({
      sessionId: z.string().min(1),
      type: z.literal('continue'),
    }),
    z.object({
      sessionId: z.string().min(1),
      type: z.literal('create'),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.type !== 'message') {
      return;
    }

    const hasText = value.text.trim().length > 0;
    const hasFiles = (value.files?.length ?? 0) > 0;
    const hasFileRefs = (value.fileRefs?.length ?? 0) > 0;

    if (hasText || hasFiles || hasFileRefs) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['text'],
      message: 'Message text is required when no files are attached',
    });
  });

export type MessageRequest = z.infer<typeof MessageRequestSchema>;
