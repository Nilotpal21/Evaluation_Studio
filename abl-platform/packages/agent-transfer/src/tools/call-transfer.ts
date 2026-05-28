/**
 * Call Transfer Tool
 *
 * Transfers a voice call via SIP or PSTN.
 * Schema matches XO's CallTransferTask (CallTransferTask.js:30-53) —
 * emits `isCallTransfer: true` with `callTransferConfig` for KoreVG.
 */
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';
import type { LLMToolDefinition } from '@abl/compiler/platform';
import type { VoiceMessagePayload, VoiceToolResult, OperationResult } from '../types.js';
import { buildVoicePayload } from '../voice/index.js';

const log = createLogger('call-transfer-tool');

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const CallTransferInputSchema = z.object({
  callTransferType: z.enum(['sip', 'pstn']),
  phoneNumber: z.string().optional(),
  sipTransferId: z.string().optional(),
  message: z.string().optional(),
  language: z.string().optional(),
});

export type CallTransferInput = z.infer<typeof CallTransferInputSchema>;

export interface CallTransferResult {
  status: 'success' | 'failed' | 'declined';
  error?: string;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export class CallTransferTool {
  /**
   * Build the KoreVG voice payload for a call transfer.
   * Matches CallTransferTask.js lines 43-53.
   */
  buildPayload(input: CallTransferInput): VoiceMessagePayload {
    return buildVoicePayload({
      message: input.message ?? '',
      isPrompt: false,
      sendDTMF: true,
      dtmfCollect: false,
      isHangUp: false,
      language: input.language,
      isCallTransfer: true,
      callTransferConfig: {
        callTransferType: input.callTransferType,
        phoneNumber: input.phoneNumber,
        sipTransferId: input.sipTransferId,
      },
      messages: input.message ? [{ type: 'text', value: input.message }] : [],
    });
  }

  /**
   * Build a `VoiceToolResult` that `korevg-session` can use to initiate
   * a SIP REFER or PSTN dial via the appropriate Jambonz verb sequence.
   */
  buildVoiceResult(input: CallTransferInput): VoiceToolResult {
    const target =
      input.callTransferType === 'pstn' ? (input.phoneNumber ?? '') : (input.sipTransferId ?? '');

    return {
      type: 'transfer',
      transferType: input.callTransferType,
      target,
    };
  }

  execute(
    input: CallTransferInput,
  ): OperationResult<{ payload: VoiceMessagePayload; voiceResult: VoiceToolResult }> {
    const parsed = CallTransferInputSchema.safeParse(input);
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

    if (data.callTransferType === 'pstn' && !data.phoneNumber) {
      return {
        success: false,
        error: {
          code: 'MISSING_PHONE_NUMBER',
          message: 'Phone number is required for PSTN call transfer',
        },
      };
    }

    if (data.callTransferType === 'sip' && !data.sipTransferId) {
      return {
        success: false,
        error: {
          code: 'MISSING_SIP_ID',
          message: 'SIP transfer ID is required for SIP call transfer',
        },
      };
    }

    const payload = this.buildPayload(data);
    const voiceResult = this.buildVoiceResult(data);
    log.info('Call transfer payload built', {
      callTransferType: data.callTransferType,
    });

    return { success: true, data: { payload, voiceResult } };
  }

  toToolDefinition(): LLMToolDefinition {
    return {
      name: 'call_transfer',
      description:
        'Transfer the current voice call to another number or SIP endpoint. Use for warm/cold transfers to external agents or phone numbers.',
      input_schema: {
        type: 'object',
        properties: {
          callTransferType: {
            type: 'string',
            enum: ['sip', 'pstn'],
            description: 'Transfer type: SIP (internal) or PSTN (phone number)',
          },
          phoneNumber: {
            type: 'string',
            description: 'Phone number to transfer to (required for PSTN)',
          },
          sipTransferId: {
            type: 'string',
            description: 'SIP transfer endpoint ID (required for SIP)',
          },
          message: {
            type: 'string',
            description: 'Message to play to the caller before transfer',
          },
          language: { type: 'string', description: 'Language for TTS' },
        },
        required: ['callTransferType'],
      },
    };
  }
}
