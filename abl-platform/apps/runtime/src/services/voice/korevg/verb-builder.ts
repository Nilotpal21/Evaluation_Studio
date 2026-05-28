/**
 * Korevg Verb Builder
 *
 * Builds Jambonz/Korevg verb responses from ABL agent outputs.
 * Supports say, gather, hangup, and listen/config verbs.
 */
import { isFluxModel, FLUX_DEFAULTS } from '@agent-platform/config';
import { sanitizeSipHeaders } from './sip-header-sanitizer.js';

const MS_PER_SECOND = 1000;

export interface KorevgVerb {
  verb: string;
  [key: string]: unknown;
}

export interface SayVerb extends KorevgVerb {
  verb: 'say';
  text?: string;
  stream?: boolean;
  synthesizer?: {
    vendor: string;
    voice: string;
    label?: string;
    language?: string;
    options?: Record<string, unknown>;
  };
}

export interface PlayVerb extends KorevgVerb {
  verb: 'play';
  url: string;
}

export interface GatherVerb extends KorevgVerb {
  verb: 'gather';
  input?: ('speech' | 'digits')[];
  actionHook?: string;
  say?: {
    text: string;
    synthesizer?: {
      vendor: string;
      voice: string;
      label?: string;
      options?: Record<string, unknown>;
    };
  };
  listen?: {
    url: string;
    mixType?: 'stereo' | 'mono';
  };
  timeout?: number;
  speechTimeout?: number;
  bargein?: boolean;
  listenDuringPrompt?: boolean;
  recognizer?: {
    vendor: string;
    language?: string;
    altLanguages?: string[];
    model?: string;
    deepgramOptions?: Record<string, unknown>;
  };
  // DTMF-specific fields for IVR digit collection
  numDigits?: number;
  maxDigits?: number;
  finishOnKey?: string;
  interDigitTimeout?: number;
}

export interface ConfigVerb extends KorevgVerb {
  verb: 'config';
  synthesizer?: {
    vendor: string;
    voice: string;
    label?: string;
    language?: string;
    options?: Record<string, unknown>;
  };
  recognizer?: {
    vendor: string;
    language?: string;
    altLanguages?: string[];
    model?: string;
    /** Vendor-specific options for Deepgram STT */
    deepgramOptions?: {
      endpointing?: boolean | number;
      utteranceEndMs?: number;
      [key: string]: unknown;
    };
  };
  bargeIn?: {
    enable: boolean;
    sticky?: boolean;
    input?: ('speech' | 'digits')[];
    actionHook?: string;
    minBargeinWordCount?: number;
    /** DTMF config: seconds to wait between digits before finalizing */
    interDigitTimeout?: number;
    /** DTMF config: minimum digits before sending */
    minDigits?: number;
    /** DTMF config: key that terminates digit collection (e.g. '#') */
    finishOnKey?: string;
    /** DTMF config: maximum digits to collect */
    numDigits?: number;
  };
  ttsStream?: {
    enable: boolean;
  };
  notifyEvents?: boolean;
  notifySttLatency?: boolean;
}

export interface AnswerVerb extends KorevgVerb {
  verb: 'answer';
}

export interface HangupVerb extends KorevgVerb {
  verb: 'hangup';
}

export interface DialVerb extends KorevgVerb {
  verb: 'dial';
  target: Array<{
    type: 'phone' | 'sip' | 'user';
    number?: string;
    sipUri?: string;
    user?: string;
    name?: string;
  }>;
  callerId?: string;
  answerOnBridge?: boolean;
  timeLimit?: number;
  timeout?: number;
  headers?: Record<string, string>;
  referHook?: string;
  actionHook?: string;
  transcribe?: {
    transcriptionHook: string;
    recognizer: {
      vendor: string;
      language?: string;
      altLanguages?: string[];
      model?: string;
      interim?: boolean;
      dualChannel?: boolean;
      separateRecognitionPerChannel?: boolean;
      diarization?: boolean;
      diarizationMinSpeakers?: number;
      diarizationMaxSpeakers?: number;
      deepgramOptions?: Record<string, unknown>;
    };
  };
}

export interface SipReferVerb extends KorevgVerb {
  verb: 'sip:refer';
  referTo: string;
  referredBy?: string;
  headers?: Record<string, string>;
  actionHook?: string;
  eventHook?: string;
}

export interface ListenVerb extends KorevgVerb {
  verb: 'listen';
  url: string;
  mixType?: 'stereo' | 'mono';
  actionHook?: string;
  finishOnKey?: string;
  timeout?: number;
  transcribe?: {
    vendor: string;
    language?: string;
    altLanguages?: string[];
  };
}

export type VerbResponse =
  | SayVerb
  | PlayVerb
  | GatherVerb
  | ConfigVerb
  | AnswerVerb
  | HangupVerb
  | ListenVerb
  | DialVerb
  | SipReferVerb;

export interface VerbBuilderConfig {
  ttsVendor?: string;
  ttsVoice?: string;
  ttsLabel?: string;
  ttsLanguage?: string;
  ttsOptions?: Record<string, unknown>;
  sttVendor?: string;
  sttLanguage?: string;
  sttAlternativeLanguages?: string[];
  sttModel?: string;
  streamingEnabled?: boolean;
  bargeIn?: boolean;
  pauseTimeoutMs?: number;
}

export interface TtsVerbOptions {
  voice?: string;
  ttsLanguage?: string;
}

export class KorevgVerbBuilder {
  private config: VerbBuilderConfig;

  constructor(config: VerbBuilderConfig = {}) {
    this.config = {
      ttsVendor: config.ttsVendor || 'elevenlabs',
      ttsVoice: config.ttsVoice || 'rachel',
      ttsLabel: config.ttsLabel,
      // ElevenLabs turbo models use ISO 639-1 codes (just 'en'), not locale codes ('en-US')
      ttsLanguage: config.ttsLanguage || 'en',
      ttsOptions: config.ttsOptions,
      sttVendor: config.sttVendor || 'deepgram',
      sttLanguage: config.sttLanguage || 'en-US',
      sttAlternativeLanguages: config.sttAlternativeLanguages,
      sttModel: config.sttModel,
      streamingEnabled: config.streamingEnabled ?? true,
      bargeIn: config.bargeIn,
      pauseTimeoutMs: config.pauseTimeoutMs,
    };
  }

  private buildSynthesizer(
    voice?: string,
    ttsLanguage?: string,
  ): NonNullable<SayVerb['synthesizer']> {
    const options = this.config.ttsOptions;
    return {
      vendor: this.config.ttsVendor!,
      voice: voice || this.config.ttsVoice!,
      label: this.getSynthesizerLabel(),
      language: ttsLanguage || this.config.ttsLanguage,
      ...(options && Object.keys(options).length > 0 ? { options } : {}),
    };
  }

  setBargeInEnabled(enabled: boolean | undefined): void {
    this.config.bargeIn = enabled;
  }

  setPauseTimeoutMs(timeoutMs: number | undefined): void {
    this.config.pauseTimeoutMs = timeoutMs;
  }

  /**
   * Returns true if the current STT config is Deepgram Flux.
   * Jambonz treats Flux as a separate vendor ('deepgramflux') that connects
   * to Deepgram's /v2/listen endpoint.
   */
  private isDeepgramFlux(): boolean {
    return this.config.sttVendor === 'deepgram' && isFluxModel(this.config.sttModel || '');
  }

  /**
   * Get the recognizer vendor for Jambonz.
   * Flux requires 'deepgramflux' vendor; all others use the configured vendor.
   */
  private getRecognizerVendor(): string {
    return this.isDeepgramFlux() ? 'deepgramflux' : this.config.sttVendor!;
  }

  private getRecognizerModel(): string | undefined {
    return this.config.sttVendor === 'google' ? this.config.sttModel : undefined;
  }

  private getRecognizerModelPayload(): { model: string } | Record<string, never> {
    const model = this.getRecognizerModel();
    return model ? { model } : {};
  }

  private getRecognizerAltLanguagePayload(): { altLanguages: string[] } | Record<string, never> {
    const primaryLanguage = this.config.sttLanguage;
    const seen = new Set<string>();
    const altLanguages = (this.config.sttAlternativeLanguages ?? [])
      .map((language) => language.trim())
      .filter((language) => {
        if (!language || language === primaryLanguage || seen.has(language)) {
          return false;
        }
        seen.add(language);
        return true;
      });

    return altLanguages.length > 0 ? { altLanguages } : {};
  }

  /**
   * Only attach tenant-scoped speech labels for vendors that require labeled
   * credential lookup on the live KoreVG TTS override path.
   */
  private getSynthesizerLabel(): string | undefined {
    return this.config.ttsVendor === 'cartesia' || this.config.ttsVendor?.startsWith('custom:')
      ? this.config.ttsLabel
      : undefined;
  }

  /**
   * Build deepgramOptions based on the active STT model.
   * Flux uses confidence-based EOT params; Nova uses silence timers.
   */
  private buildDeepgramOptions(includeEndpointing: boolean): Record<string, unknown> | undefined {
    const pauseTimeoutMs = this.config.pauseTimeoutMs;
    if (this.isDeepgramFlux()) {
      // Flux: Jambonz handles /v2/listen via 'deepgramflux' vendor.
      // EOT params go in deepgramOptions; no manual endpointing timers.
      // NOTE: eagerEotThreshold is omitted — our session processes every verb:hook
      // as a full turn, so EagerEndOfTurn causes duplicate responses.
      // Add it back when the session supports speculative LLM pre-warming.
      return {
        eotThreshold: FLUX_DEFAULTS.eotThreshold,
        eotTimeoutMs: pauseTimeoutMs ?? FLUX_DEFAULTS.eotTimeoutMs,
      };
    }

    if (this.config.sttVendor !== 'deepgram') {
      return undefined;
    }

    // Nova/other Deepgram models: silence timers for streaming, no extra opts for gather/config
    return includeEndpointing
      ? {
          endpointing: pauseTimeoutMs ?? 600,
          utteranceEndMs: pauseTimeoutMs ?? 1500,
        }
      : undefined;
  }

  private pauseTimeoutSeconds(): number | undefined {
    return this.config.pauseTimeoutMs === undefined
      ? undefined
      : Math.max(1, Math.ceil(this.config.pauseTimeoutMs / MS_PER_SECOND));
  }

  /**
   * Build a say verb for text-to-speech
   */
  say(text: string, options: { streaming?: boolean } & TtsVerbOptions = {}): SayVerb {
    const verb: SayVerb = {
      verb: 'say',
      text,
    };

    // Add synthesizer config
    verb.synthesizer = this.buildSynthesizer(options.voice, options.ttsLanguage);

    return verb;
  }

  /**
   * Build a play verb for pre-generated audio
   */
  play(url: string): PlayVerb {
    return {
      verb: 'play',
      url,
    };
  }

  /**
   * Build a gather verb to collect speech input
   * If actionHook is omitted, Jambonz will send results back over WebSocket
   */
  gather(
    options: {
      actionHook?: string;
      prompt?: string;
      timeout?: number;
      speechTimeout?: number;
      listenUrl?: string;
      bargein?: boolean;
      listenDuringPrompt?: boolean;
      input?: ('speech' | 'dtmf')[];
      maxDigits?: number;
      numDigits?: number;
      finishOnKey?: string;
      interDigitTimeout?: number;
    } = {},
  ): GatherVerb {
    const verb: GatherVerb = {
      verb: 'gather',
      input: ['speech', 'digits'],
    };

    // Only include actionHook if provided (for HTTP callback mode)
    // If omitted, Jambonz uses WebSocket mode and sends verb:hook messages
    if (options.actionHook) {
      verb.actionHook = options.actionHook;
    }

    // Add prompt if provided
    if (options.prompt) {
      verb.say = {
        text: options.prompt,
        synthesizer: this.buildSynthesizer(),
      };
    }

    // Add listen config for real-time transcription if URL provided
    if (options.listenUrl) {
      verb.listen = {
        url: options.listenUrl,
        mixType: 'mono',
      };
    }

    // Add timeouts
    if (options.timeout !== undefined) {
      verb.timeout = options.timeout;
    }
    const speechTimeout = options.speechTimeout ?? this.pauseTimeoutSeconds();
    if (speechTimeout) {
      verb.speechTimeout = speechTimeout;
    }

    // Enable bargein (allows user to interrupt prompt by speaking)
    // Default to true for better UX
    const defaultBargeIn = this.config.bargeIn !== false;
    verb.bargein = options.bargein !== undefined ? options.bargein : defaultBargeIn;
    verb.listenDuringPrompt =
      options.listenDuringPrompt !== undefined ? options.listenDuringPrompt : defaultBargeIn;

    // DTMF-specific fields for digit collection
    if (options.maxDigits) {
      verb.maxDigits = options.maxDigits;
    }
    if (options.numDigits) {
      verb.numDigits = options.numDigits;
    }
    if (options.finishOnKey) {
      verb.finishOnKey = options.finishOnKey;
    }
    if (options.interDigitTimeout) {
      verb.interDigitTimeout = options.interDigitTimeout;
    }

    // Add recognizer config — Flux uses 'deepgramflux' vendor
    const gatherDgOpts = this.buildDeepgramOptions(false);
    verb.recognizer = {
      vendor: this.getRecognizerVendor(),
      language: this.config.sttLanguage,
      ...this.getRecognizerAltLanguagePayload(),
      ...this.getRecognizerModelPayload(),
      ...(gatherDgOpts && { deepgramOptions: gatherDgOpts }),
    };

    return verb;
  }

  /**
   * Build a listen verb for continuous transcription
   */
  listen(
    wsUrl: string,
    options: {
      actionHook?: string;
      timeout?: number;
    } = {},
  ): ListenVerb {
    const verb: ListenVerb = {
      verb: 'listen',
      url: wsUrl,
      mixType: 'mono',
    };

    if (options.actionHook) {
      verb.actionHook = options.actionHook;
    }

    if (options.timeout) {
      verb.timeout = options.timeout;
    }

    verb.transcribe = {
      vendor: this.config.sttVendor!,
      language: this.config.sttLanguage,
      ...this.getRecognizerAltLanguagePayload(),
    };

    return verb;
  }

  /**
   * Build a config verb to set TTS/STT defaults
   */
  buildConfig(
    options: {
      ttsVendor?: string;
      ttsVoice?: string;
      ttsLanguage?: string;
      sttVendor?: string;
    } = {},
  ): ConfigVerb {
    const verb: ConfigVerb = {
      verb: 'config',
    };

    const vendor = options.ttsVendor || this.config.ttsVendor!;

    // Add synthesizer config
    verb.synthesizer = {
      ...this.buildSynthesizer(options.ttsVoice, options.ttsLanguage),
      vendor,
    };

    // Add recognizer config — Flux uses 'deepgramflux' vendor
    const configDgOpts = this.buildDeepgramOptions(false);
    verb.recognizer = {
      vendor: options.sttVendor || this.getRecognizerVendor(),
      language: this.config.sttLanguage,
      ...this.getRecognizerAltLanguagePayload(),
      ...(options.sttVendor ? {} : this.getRecognizerModelPayload()),
      ...(configDgOpts && { deepgramOptions: configDgOpts }),
    };

    return verb;
  }

  /**
   * Build a config verb with sticky background gather and TTS streaming.
   * Streaming speech text is delivered separately through tts:tokens.
   */
  buildStreamingConfig(
    actionHook: string,
    options?: { streaming?: boolean } & TtsVerbOptions,
  ): ConfigVerb {
    const useStreaming = options?.streaming !== false; // default true

    const verb: ConfigVerb = {
      verb: 'config',
      notifySttLatency: true, // Enable Jambonz SttLatencyCalculator (Silero VAD reference clock)
    };

    // Add synthesizer config
    verb.synthesizer = this.buildSynthesizer(options?.voice, options?.ttsLanguage);

    // Add recognizer config — Flux uses 'deepgramflux' vendor; Nova uses 'deepgram'
    const streamingDeepgramOptions = this.buildDeepgramOptions(true);
    verb.recognizer = {
      vendor: this.getRecognizerVendor(),
      language: this.config.sttLanguage,
      ...this.getRecognizerAltLanguagePayload(),
      ...this.getRecognizerModelPayload(),
      ...(streamingDeepgramOptions ? { deepgramOptions: streamingDeepgramOptions } : {}),
    };

    // Enable sticky background gather with barge-in (speech + DTMF for Metric 209)
    verb.bargeIn = {
      enable: this.config.bargeIn !== false,
      sticky: true, // Auto-restart after each detection
      input: ['speech', 'digits'],
      actionHook,
      minBargeinWordCount: 1,
      interDigitTimeout: 2,
      minDigits: 1,
      finishOnKey: '#',
      numDigits: 12,
    };

    // Enable TTS streaming
    verb.ttsStream = {
      enable: useStreaming,
    };

    // Enable verb:status events (e.g. synthesized-audio with TTS TTFB)
    verb.notifyEvents = true;

    return verb;
  }

  /**
   * Build an answer verb to answer the incoming call
   */
  answer(): AnswerVerb {
    return {
      verb: 'answer',
    };
  }

  /**
   * Build a hangup verb to end the call
   */
  hangup(): HangupVerb {
    return {
      verb: 'hangup',
    };
  }

  /**
   * Build a dial verb for PSTN call transfer (cold/blind transfer).
   * Jambonz bridges the existing call to the target number.
   */
  dial(options: {
    number: string;
    callerId?: string;
    timeout?: number;
    timeLimit?: number;
    headers?: Record<string, string>;
    answerOnBridge?: boolean;
  }): DialVerb {
    return {
      verb: 'dial',
      target: [{ type: 'phone', number: options.number }],
      callerId: options.callerId,
      answerOnBridge: options.answerOnBridge ?? true,
      timeout: options.timeout ?? 30,
      timeLimit: options.timeLimit,
      headers: sanitizeSipHeaders(options.headers),
    };
  }

  /**
   * Build a SIP dial verb for SIP-based call transfer.
   */
  dialSip(options: {
    sipUri: string;
    callerId?: string;
    timeout?: number;
    headers?: Record<string, string>;
  }): DialVerb {
    return {
      verb: 'dial',
      target: [{ type: 'sip', sipUri: options.sipUri }],
      callerId: options.callerId,
      answerOnBridge: true,
      timeout: options.timeout ?? 30,
      headers: sanitizeSipHeaders(options.headers),
    };
  }

  /**
   * Build a dial verb targeting a registered jambonz user.
   * The agent registers on jambonz via WebRTC SIP REGISTER;
   * jambonz routes the call directly without an external trunk.
   */
  dialUser(options: {
    name: string;
    callerId?: string;
    timeout?: number;
    actionHook?: string;
    transcriptionHook?: string;
  }): DialVerb {
    const verb: DialVerb = {
      verb: 'dial',
      target: [{ type: 'user', name: options.name }],
      callerId: options.callerId,
      answerOnBridge: false,
      timeout: options.timeout ?? 30,
      actionHook: options.actionHook,
    };

    if (options.transcriptionHook) {
      verb.transcribe = {
        transcriptionHook: options.transcriptionHook,
        recognizer: {
          vendor: this.getRecognizerVendor(),
          language: this.config.sttLanguage,
          ...this.getRecognizerModelPayload(),
          interim: false,
          dualChannel: true,
          separateRecognitionPerChannel: true,
          diarization: true,
          diarizationMinSpeakers: 1,
          diarizationMaxSpeakers: 2,
          ...(this.config.sttVendor === 'deepgram'
            ? { deepgramOptions: this.buildDeepgramOptions(false) }
            : {}),
        },
      };
    }

    return verb;
  }

  /**
   * Build a SIP REFER verb for attended/blind SIP transfer.
   * Sends a SIP REFER to the far-end UA to redirect the call.
   */
  refer(options: {
    referTo: string;
    referredBy?: string;
    headers?: Record<string, string>;
    actionHook?: string;
    eventHook?: string;
  }): SipReferVerb {
    return {
      verb: 'sip:refer',
      referTo: options.referTo,
      referredBy: options.referredBy,
      headers: sanitizeSipHeaders(options.headers),
      actionHook: options.actionHook,
      eventHook: options.eventHook,
    };
  }
}
