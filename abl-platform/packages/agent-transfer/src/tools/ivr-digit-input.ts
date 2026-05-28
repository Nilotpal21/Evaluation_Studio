/**
 * IVR Digit Input Tool
 *
 * Collects multi-digit DTMF input from the caller (e.g. account number, ZIP code).
 * Schema matches XO's IVRDigitTask (IVRDigitTask.js) — emits the same
 * payload shape so KoreVG can collect DTMF digits with configurable length.
 */
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';
import type { LLMToolDefinition } from '@abl/compiler/platform';
import type { VoiceMessagePayload, VoiceToolResult, OperationResult } from '../types.js';
import { buildVoicePayload } from '../voice/index.js';

const log = createLogger('ivr-digit-input-tool');

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const DigitNoInputConfigSchema = z.object({
  timeout: z.number().int().min(1).max(120, 'Timeout must be 1-120 seconds'),
  maxRetries: z.number().int().min(0).max(10),
  message: z.string().min(1),
});

const DigitNoMatchConfigSchema = z.object({
  maxRetries: z.number().int().min(0).max(10),
  message: z.string().min(1),
});

export const IVRDigitInputSchema = z.object({
  prompt: z.string().min(1, 'Digit input prompt is required'),
  maxDigits: z.number().int().min(1).max(20).optional().default(10),
  endingKeyPress: z.string().max(1).optional(),
  interDigitTimeout: z.number().int().min(500).max(30_000).optional().default(2000),
  noInputConfig: DigitNoInputConfigSchema,
  noMatchConfig: DigitNoMatchConfigSchema,
  language: z.string().optional(),
});

export type IVRDigitInput = z.infer<typeof IVRDigitInputSchema>;

export type IVRDigitBranch = 'success' | 'noInput' | 'noMatch';

export interface IVRDigitResult {
  digits: string;
  completed: boolean;
  branch: IVRDigitBranch;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export class IVRDigitInputTool {
  /**
   * Build the KoreVG voice payload for digit collection.
   * Matches IVRDigitTask.js payload shape: dtmfCollect=true, variable maxDigits.
   */
  buildPayload(input: IVRDigitInput): VoiceMessagePayload {
    let dtmfCollectMaxDigits = input.maxDigits ?? 10;
    if (input.endingKeyPress && input.endingKeyPress.length > 0) {
      dtmfCollectMaxDigits += 1;
    }

    return buildVoicePayload({
      message: input.prompt,
      isPrompt: true,
      sendDTMF: true,
      dtmfCollect: true,
      timeout: input.noInputConfig.timeout * 1000,
      retries: input.noInputConfig.maxRetries,
      enableSpeechInput: false,
      isHangUp: false,
      language: input.language,
      dtmfCollectInterDigitTimeoutMS: input.interDigitTimeout ?? 2000,
      dtmfCollectMaxDigits,
      dtmfCollectSubmitDigit: input.endingKeyPress,
      messages: [{ type: 'text', value: input.prompt }],
    });
  }

  /**
   * Build a `VoiceToolResult` that `korevg-session` can translate into
   * Jambonz verbs via `verb-builder`. The `gather` type maps to
   * `KorevgVerbBuilder.gather()` with DTMF input mode and digit-collection params.
   */
  buildVoiceResult(input: IVRDigitInput): VoiceToolResult {
    return {
      type: 'gather',
      prompt: input.prompt,
      input: ['dtmf'],
      timeout: input.noInputConfig.timeout,
      maxDigits: input.maxDigits,
      finishOnKey: input.endingKeyPress,
      interDigitTimeout: input.interDigitTimeout,
      retries: {
        noInput: input.noInputConfig.maxRetries,
        noMatch: input.noMatchConfig.maxRetries,
        noInputPrompt: input.noInputConfig.message,
        noMatchPrompt: input.noMatchConfig.message,
      },
    };
  }

  execute(
    input: IVRDigitInput,
  ): OperationResult<{ payload: VoiceMessagePayload; voiceResult: VoiceToolResult }> {
    const parsed = IVRDigitInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      };
    }

    const payload = this.buildPayload(parsed.data);
    const voiceResult = this.buildVoiceResult(parsed.data);
    log.info('IVR digit input payload built', {
      maxDigits: parsed.data.maxDigits,
      endingKeyPress: parsed.data.endingKeyPress,
    });

    return { success: true, data: { payload, voiceResult } };
  }

  toToolDefinition(): LLMToolDefinition {
    return {
      name: 'ivr_digit_input',
      description:
        'Collect multi-digit DTMF input from the voice caller (e.g. account number, PIN, ZIP code). Configurable digit length and ending key.',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The prompt message to play (TTS)' },
          maxDigits: {
            type: 'number',
            description: 'Maximum number of digits to collect (default 10)',
          },
          endingKeyPress: {
            type: 'string',
            description: 'Key that signals end of input (e.g. "#")',
          },
          interDigitTimeout: {
            type: 'number',
            description: 'Milliseconds to wait between digits (default 2000)',
          },
          noInputConfig: {
            type: 'object',
            description:
              'No-input config: {timeout: number (seconds 1-120), maxRetries: number (0-10), message: string}',
          },
          noMatchConfig: {
            type: 'object',
            description: 'No-match config: {maxRetries: number (0-10), message: string}',
          },
          language: { type: 'string', description: 'Language for TTS' },
        },
        required: ['prompt', 'noInputConfig', 'noMatchConfig'],
      },
    };
  }
}
