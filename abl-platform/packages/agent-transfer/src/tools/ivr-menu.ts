/**
 * IVR Menu Tool
 *
 * Presents a DTMF menu to the caller and collects a single digit response.
 * Schema matches XO's IVRMenuTask (IVRMenuTask.js) — emits the same
 * payload shape so KoreVG can render the menu prompt and collect DTMF.
 */
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';
import type { LLMToolDefinition } from '@abl/compiler/platform';
import type { VoiceMessagePayload, VoiceToolResult, OperationResult } from '../types.js';
import { buildVoicePayload } from '../voice/index.js';

const log = createLogger('ivr-menu-tool');

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const DTMFMappingSchema = z.object({
  key: z.string().min(1).max(1, 'DTMF key must be a single character'),
  nextStep: z.string().min(1),
  intent: z.string().optional(),
});

const NoInputConfigSchema = z.object({
  timeout: z.number().int().min(1).max(120, 'Timeout must be 1-120 seconds'),
  maxRetries: z.number().int().min(0).max(10),
  message: z.string().min(1),
});

const NoMatchConfigSchema = z.object({
  maxRetries: z.number().int().min(0).max(10),
  message: z.string().min(1),
});

export const IVRMenuInputSchema = z.object({
  prompt: z.string().min(1, 'Menu prompt is required'),
  dtmfMappings: z
    .array(DTMFMappingSchema)
    .min(1, 'At least one DTMF mapping is required')
    .max(12, 'Maximum 12 DTMF mappings'),
  noInputConfig: NoInputConfigSchema,
  noMatchConfig: NoMatchConfigSchema,
  bargeIn: z.boolean().optional(),
  language: z.string().optional(),
});

export type IVRMenuInput = z.infer<typeof IVRMenuInputSchema>;

export type IVRMenuBranch = 'match' | 'noInput' | 'noMatch';

export interface IVRMenuResult {
  digit: string;
  matched: boolean;
  mappedIntent?: string;
  branch: IVRMenuBranch;
}

// ---------------------------------------------------------------------------
// IVR Menu constants (matching XO IVRMenuTask.js)
// ---------------------------------------------------------------------------

const IVR_MENU_DTMF_SUBMIT_DIGIT = '$';
const IVR_MENU_INTER_DIGIT_TIMEOUT_MS = 100;

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export class IVRMenuTool {
  /**
   * Build the KoreVG voice payload for an IVR menu prompt.
   * This payload is sent to KoreVG which renders the TTS and collects DTMF.
   */
  buildPayload(input: IVRMenuInput): VoiceMessagePayload {
    return buildVoicePayload({
      message: input.prompt,
      isPrompt: true,
      sendDTMF: true,
      dtmfCollect: false,
      timeout: input.noInputConfig.timeout * 1000,
      retries: input.noInputConfig.maxRetries,
      bargeIn: input.bargeIn,
      enableSpeechInput: false,
      isHangUp: false,
      language: input.language,
      dtmfCollectSubmitDigit: IVR_MENU_DTMF_SUBMIT_DIGIT,
      dtmfCollectInterDigitTimeoutMS: IVR_MENU_INTER_DIGIT_TIMEOUT_MS,
      messages: [{ type: 'text', value: input.prompt }],
    });
  }

  /**
   * Validate a DTMF response against the menu mappings.
   * Called when KoreVG sends back the user's DTMF input.
   */
  validateDTMFResponse(input: IVRMenuInput, digit: string): IVRMenuResult {
    const mapping = input.dtmfMappings.find((m) => m.key === digit);
    if (mapping) {
      return {
        digit,
        matched: true,
        mappedIntent: mapping.intent,
        branch: 'match',
      };
    }
    return { digit, matched: false, branch: 'noMatch' };
  }

  /**
   * Build a `VoiceToolResult` that `korevg-session` can translate into
   * Jambonz verbs via `verb-builder`. The `gather` type maps to
   * `KorevgVerbBuilder.gather()` with DTMF input mode.
   */
  buildVoiceResult(input: IVRMenuInput): VoiceToolResult {
    const dtmfMappings: Record<string, { label: string; intent?: string }> = {};
    for (const m of input.dtmfMappings) {
      dtmfMappings[m.key] = { label: m.nextStep, intent: m.intent };
    }

    return {
      type: 'gather',
      prompt: input.prompt,
      input: ['dtmf'],
      dtmfMappings,
      timeout: input.noInputConfig.timeout,
      bargeIn: input.bargeIn,
      retries: {
        noInput: input.noInputConfig.maxRetries,
        noMatch: input.noMatchConfig.maxRetries,
        noInputPrompt: input.noInputConfig.message,
        noMatchPrompt: input.noMatchConfig.message,
      },
    };
  }

  execute(
    input: IVRMenuInput,
  ): OperationResult<{ payload: VoiceMessagePayload; voiceResult: VoiceToolResult }> {
    const parsed = IVRMenuInputSchema.safeParse(input);
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
    log.info('IVR menu payload built', {
      mappingCount: parsed.data.dtmfMappings.length,
      bargeIn: parsed.data.bargeIn,
    });

    return { success: true, data: { payload, voiceResult } };
  }

  toToolDefinition(): LLMToolDefinition {
    return {
      name: 'ivr_menu',
      description:
        'Present a DTMF menu to the voice caller. The caller presses a digit to select an option. Use for voice IVR flows with numbered choices.',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The menu prompt message (played via TTS)' },
          dtmfMappings: {
            type: 'array',
            description:
              'Array of DTMF digit mappings. Each element: {key: string (0-9,*,#), nextStep: string, intent?: string}',
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
          bargeIn: {
            type: 'boolean',
            description: 'Allow caller to interrupt the prompt with a digit',
          },
          language: { type: 'string', description: 'Language for TTS (e.g. "en")' },
        },
        required: ['prompt', 'dtmfMappings', 'noInputConfig', 'noMatchConfig'],
      },
    };
  }
}
