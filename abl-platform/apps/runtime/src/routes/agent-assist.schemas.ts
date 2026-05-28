import { z } from 'zod';
import { AGENT_ASSIST_MAX_INPUT_CHARS } from '../services/agent-assist/constants.js';

/**
 * Zod schemas for the Agent Assist V1 compatibility facade.
 *
 * Matches the payload Kore.ai Agent Assist sends — including several optional
 * fields accepted for forward-compatibility but not acted on yet
 * (`invoke`, `attachments`, `additionalArgs`, `metrics`, debug options).
 *
 * `.passthrough()` is used deliberately on `metadata` since callers ship arbitrary
 * operator context (conversationId, botId, language, customData, ...). Reserved-key
 * stripping happens downstream in `metadata-normalizer.ts`, not here.
 */

const sessionIdentitySchema = z.object({
  // Kore.ai's docs list "sessionIdentity" as a type literal alongside
  // sessionReference / sessionId / userReference. Some client builds use
  // "sessionIdentity" interchangeably with "sessionId" — accept both.
  type: z.enum(['sessionReference', 'sessionId', 'sessionIdentity', 'userReference']),
  value: z.string().min(1),
});

const textInputSchema = z.object({
  type: z.literal('text'),
  content: z.string().max(AGENT_ASSIST_MAX_INPUT_CHARS),
});

const structuredInputSchema = z.object({
  type: z.enum(['object', 'tool_input']),
  content: z.union([z.string().max(AGENT_ASSIST_MAX_INPUT_CHARS), z.record(z.unknown())]),
});

const inputItemSchema = z.discriminatedUnion('type', [textInputSchema, structuredInputSchema]);

const streamOptionsSchema = z
  .object({
    enable: z.boolean().optional(),
    streamMode: z.enum(['tokens', 'messages']).optional(),
  })
  .strict();

const debugOptionsSchema = z
  .object({
    enable: z.boolean().optional(),
    debugMode: z.enum(['full', 'thoughts']).optional(),
  })
  .strict();

export const v1ExecuteBodySchema = z
  .object({
    sessionIdentity: z.array(sessionIdentitySchema).min(1),
    input: z.array(inputItemSchema).min(1),
    stream: streamOptionsSchema.optional(),
    debug: debugOptionsSchema.optional(),
    source: z.string().max(128).optional(),
    metadata: z.record(z.unknown()).optional(),
    isAsync: z.boolean().optional(),
    // Kore.ai Agent Assist's runtime sends a RELATIVE path here
    // (e.g. "/agentassist/api/v1/aa/linkedapps/agenticresponse"), so we
    // cannot enforce z.string().url(). Deeper shape/host-allowlist validation
    // runs downstream in the callback URL validator.
    callbackUrl: z.string().optional(),
    // Forward-compat passthrough — accepted, ignored.
    invoke: z.unknown().optional(),
    attachments: z.unknown().optional(),
    additionalArgs: z.unknown().optional(),
    metrics: z.unknown().optional(),
  })
  .strict();

export const v1SessionsBodySchema = z
  .object({
    sessionIdentity: z.array(sessionIdentitySchema).min(1),
    metadata: z.record(z.unknown()).optional(),
    source: z.string().max(128).optional(),
  })
  .strict();

export type V1ExecuteBody = z.infer<typeof v1ExecuteBodySchema>;
export type V1SessionsBody = z.infer<typeof v1SessionsBodySchema>;
