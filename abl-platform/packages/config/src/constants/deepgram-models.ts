/**
 * Deepgram STT model definitions — shared by runtime (verb builder)
 * and Studio (model dropdown in VoiceServicesPage).
 */

export interface DeepgramModelOption {
  id: string;
  label: string;
  isFluxFamily: boolean;
}

/**
 * Supported Deepgram STT models shown in the Studio UI dropdown.
 * To add a new model, append here — both backend and frontend pick it up.
 */
export const DEEPGRAM_STT_MODELS: DeepgramModelOption[] = [
  {
    id: 'nova-3',
    label: 'Nova 3 (latest, most accurate)',
    isFluxFamily: false,
  },
  { id: 'nova-2', label: 'Nova 2 (stable)', isFluxFamily: false },
  { id: 'nova-2-phonecall', label: 'Nova 2 Phone Call', isFluxFamily: false },
  {
    id: 'flux-general-en',
    label: 'Flux Conversational (English only)',
    isFluxFamily: true,
  },
];

export const DEFAULT_DEEPGRAM_STT_MODEL = 'nova-3';

/**
 * Check if a model ID belongs to the Flux family.
 * Uses prefix matching to future-proof against new Flux variants
 * (e.g., flux-general-es, flux-medical-en).
 */
export function isFluxModel(modelId: string): boolean {
  return modelId.startsWith('flux');
}

/**
 * Default Flux end-of-turn parameters for Jambonz deepgramOptions.
 * These replace Nova's endpointing/utteranceEndMs when Flux is active.
 *
 * Jambonz uses 'deepgramflux' as a separate vendor that routes to
 * Deepgram's /v2/listen endpoint automatically.
 *
 * NOTE: eagerEotThreshold is intentionally omitted. It causes EagerEndOfTurn
 * events that trigger duplicate verb:hook callbacks — the KoreVG session
 * processes each as a full turn, resulting in double responses.
 * Add it back when the session supports speculative LLM pre-warming.
 *
 * @see https://developers.deepgram.com/docs/flux/configuration
 * @see https://docs.jambonz.org/verbs/verbs/recognizer (deepgramOptions)
 */
export const FLUX_DEFAULTS = {
  /** Confidence threshold for EndOfTurn event (0.5-0.9) */
  eotThreshold: 0.7,
  /** Max silence (ms) before forced EndOfTurn regardless of confidence (500-10000) */
  eotTimeoutMs: 5000,
};
