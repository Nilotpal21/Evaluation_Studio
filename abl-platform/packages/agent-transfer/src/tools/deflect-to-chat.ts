/**
 * Deflect-to-Chat Tool
 *
 * Deflects a voice call to a chat channel — either to automation (bot)
 * or to agent transfer (human). Matches XO's DeflectToChatTask branching
 * logic (DeflectToChatTask.js:101-120).
 */
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';
import type { LLMToolDefinition } from '@abl/compiler/platform';
import type { VoiceMessagePayload, VoiceToolResult, OperationResult } from '../types.js';
import { buildVoicePayload } from '../voice/index.js';

const log = createLogger('deflect-to-chat-tool');

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const DeflectToChatInputSchema = z.object({
  deflectionType: z.enum(['automation', 'agentTransfer']),
  message: z.string().optional(),
  triggerType: z.enum(['userSelection', 'automationContext']).optional(),
  language: z.string().optional(),
});

export type DeflectToChatInput = z.infer<typeof DeflectToChatInputSchema>;

export type DeflectBranch = 'DEFLECT_AUTOMATION' | 'DEFLECT_AGENT_TRANSFER';

export interface DeflectToChatResult {
  deflected: boolean;
  branch: DeflectBranch;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export class DeflectToChatTool {
  /**
   * Resolve the deflection branch matching DeflectToChatTask.js logic.
   *
   * From XO (lines 101-105):
   *   shouldDeflectToAutomation =
   *     (triggerType === 'userSelection' && type === 'automatedDialog') ||
   *     (deflectToChat === 'automation' && triggerType === 'automationContext')
   */
  resolveBranch(input: DeflectToChatInput): DeflectBranch {
    const shouldDeflectToAutomation =
      (input.triggerType === 'userSelection' && input.deflectionType === 'automation') ||
      (input.deflectionType === 'automation' && input.triggerType === 'automationContext');

    return shouldDeflectToAutomation ? 'DEFLECT_AUTOMATION' : 'DEFLECT_AGENT_TRANSFER';
  }

  /** Build the KoreVG voice payload for the deflection message. */
  buildPayload(input: DeflectToChatInput): VoiceMessagePayload {
    return buildVoicePayload({
      message: input.message ?? '',
      isPrompt: false,
      sendDTMF: true,
      dtmfCollect: false,
      isHangUp: false,
      language: input.language,
      messages: input.message ? [{ type: 'text', value: input.message }] : [],
    });
  }

  /**
   * Build a `VoiceToolResult` that `korevg-session` can use to coordinate
   * a channel switch from voice to chat. There is no direct Jambonz verb
   * for deflection — the session handler uses this metadata to orchestrate
   * the handoff.
   */
  buildVoiceResult(input: DeflectToChatInput): VoiceToolResult {
    const branch = this.resolveBranch(input);
    return {
      type: 'deflect',
      targetChannel: input.deflectionType,
      metadata: {
        branch,
        triggerType: input.triggerType,
      },
    };
  }

  execute(
    input: DeflectToChatInput,
  ): OperationResult<
    DeflectToChatResult & { payload: VoiceMessagePayload; voiceResult: VoiceToolResult }
  > {
    const parsed = DeflectToChatInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      };
    }

    const data = parsed.data;
    const branch = this.resolveBranch(data);
    const payload = this.buildPayload(data);
    const voiceResult = this.buildVoiceResult(data);

    log.info('Deflect-to-chat executed', {
      deflectionType: data.deflectionType,
      triggerType: data.triggerType,
      branch,
    });

    return {
      success: true,
      data: { deflected: true, branch, payload, voiceResult },
    };
  }

  toToolDefinition(): LLMToolDefinition {
    return {
      name: 'deflect_to_chat',
      description:
        'Deflect the current voice call to a chat channel. The caller will continue the conversation via text chat, either with a bot (automation) or a human agent.',
      input_schema: {
        type: 'object',
        properties: {
          deflectionType: {
            type: 'string',
            enum: ['automation', 'agentTransfer'],
            description: 'Deflect to bot automation or to human agent transfer',
          },
          message: {
            type: 'string',
            description: 'Message to play before deflection',
          },
          triggerType: {
            type: 'string',
            enum: ['userSelection', 'automationContext'],
            description: 'How the deflection was triggered',
          },
          language: { type: 'string', description: 'Language for TTS' },
        },
        required: ['deflectionType'],
      },
    };
  }
}
