/**
 * VADAdapter — Voice Activity Detection wrapper.
 *
 * Provides two implementations:
 * - VADAdapter: Loads @ricky0123/vad-web browser bundles without eval-like
 *   dynamic import helpers. Falls back gracefully if the optional bundle is
 *   unavailable.
 * - ManualVADAdapter: Push-to-talk fallback that emits the same events
 *   triggered by explicit startSpeech()/endSpeech() calls.
 *
 * VAD config defaults match the preview page implementation.
 */

import { TypedEventEmitter } from '../core/EventEmitter.js';

// =============================================================================
// TYPES
// =============================================================================

export interface VADConfig {
  /** Confidence threshold to detect speech (default: 0.8) */
  positiveSpeechThreshold?: number;
  /** Confidence threshold to detect silence (default: 0.4) */
  negativeSpeechThreshold?: number;
  /** Grace period before speech end in ms (default: 120) */
  redemptionMs?: number;
  /** Minimum speech duration before confirmation in ms (default: 90) */
  minSpeechMs?: number;
  /** Audio to include before speech starts in ms (default: 150) */
  preSpeechPadMs?: number;
  /** Base asset path for ONNX models (default: unpkg CDN) */
  baseAssetPath?: string;
  /** ONNX WASM base path (default: unpkg CDN) */
  onnxWASMBasePath?: string;
  /** Browser bundle URL for @ricky0123/vad-web */
  vadScriptUrl?: string;
  /** Browser bundle URL for onnxruntime-web */
  onnxRuntimeScriptUrl?: string;
  /** CSP nonce to apply to dynamically inserted VAD/ONNX script tags */
  scriptNonce?: string;
}

export interface VADEvents {
  /** Speech started — user began talking */
  speechStart: void;
  /** Speech ended — includes the captured audio as Float32Array */
  speechEnd: { audio: Float32Array };
  /** VAD misfire — detected noise, not speech */
  misfire: void;
  /** VAD initialization result */
  initialized: { available: boolean };
  /** VAD error */
  error: { error: Error };
}

// Default VAD configuration matching preview/page.tsx
const VAD_DEFAULTS: Required<
  Pick<
    VADConfig,
    | 'positiveSpeechThreshold'
    | 'negativeSpeechThreshold'
    | 'redemptionMs'
    | 'minSpeechMs'
    | 'preSpeechPadMs'
  >
> = {
  positiveSpeechThreshold: 0.8,
  negativeSpeechThreshold: 0.4,
  redemptionMs: 120,
  minSpeechMs: 90,
  preSpeechPadMs: 150,
};

const DEFAULT_BASE_ASSET_PATH = 'https://unpkg.com/@ricky0123/vad-web@0.0.30/dist/';
const DEFAULT_ONNX_WASM_PATH = 'https://unpkg.com/onnxruntime-web@1.24.1/dist/';
const DEFAULT_VAD_SCRIPT_URL = `${DEFAULT_BASE_ASSET_PATH}bundle.min.js`;
const DEFAULT_ONNX_RUNTIME_SCRIPT_URL = `${DEFAULT_ONNX_WASM_PATH}ort.wasm.min.js`;

interface MicVADOptions {
  baseAssetPath: string;
  onnxWASMBasePath: string;
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  redemptionMs: number;
  minSpeechMs: number;
  preSpeechPadMs: number;
  onSpeechStart: () => void;
  onSpeechEnd: (audio: Float32Array) => void;
  onVADMisfire: () => void;
}

interface VADInstance {
  start: () => void;
  pause: () => void;
  destroy?: () => void | Promise<void>;
}

interface MicVADFactory {
  new: (options: MicVADOptions) => Promise<VADInstance>;
}

interface BrowserVADModule {
  MicVAD?: MicVADFactory;
  default?: {
    MicVAD?: MicVADFactory;
  };
}

type VADGlobal = typeof globalThis & {
  ort?: unknown;
  vad?: BrowserVADModule;
};

const MAX_IN_FLIGHT_SCRIPT_LOADS = 16;
const onnxRuntimeScriptPromises = new Map<string, Promise<void>>();
const vadScriptPromises = new Map<string, Promise<void>>();

function getVADGlobal(): VADGlobal {
  return globalThis as VADGlobal;
}

function resolveScriptNonce(configuredNonce?: string): string | undefined {
  const nonce = configuredNonce?.trim();
  if (nonce) {
    return nonce;
  }

  if (typeof document === 'undefined') {
    return undefined;
  }

  const currentScriptNonce =
    document.currentScript instanceof HTMLScriptElement
      ? document.currentScript.nonce || document.currentScript.getAttribute('nonce') || undefined
      : undefined;
  if (currentScriptNonce) {
    return currentScriptNonce;
  }

  return (
    document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce ||
    document.querySelector<HTMLScriptElement>('script[nonce]')?.getAttribute('nonce') ||
    undefined
  );
}

function resolveBrowserScriptUrl(src: string): string {
  if (typeof document === 'undefined') {
    return src;
  }

  const resolvedUrl = new URL(src, document.baseURI);
  if (resolvedUrl.protocol !== 'https:' && resolvedUrl.protocol !== 'http:') {
    throw new Error(`Unsupported browser script URL protocol: ${resolvedUrl.protocol}`);
  }
  if (resolvedUrl.username || resolvedUrl.password) {
    throw new Error('Browser script URLs must not include credentials');
  }
  return resolvedUrl.href;
}

function loadBrowserScript(
  src: string,
  isReady: () => boolean,
  resolvedNonce?: string,
): Promise<void> {
  if (isReady()) {
    return Promise.resolve();
  }

  if (typeof document === 'undefined') {
    return Promise.reject(new Error(`Cannot load browser script outside a document: ${src}`));
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    if (resolvedNonce) {
      script.nonce = resolvedNonce;
    }
    script.onload = () => {
      if (isReady()) {
        resolve();
      } else {
        reject(new Error(`Browser script loaded without exposing its expected global: ${src}`));
      }
    };
    script.onerror = () => reject(new Error(`Failed to load browser script: ${src}`));
    (document.head ?? document.documentElement).appendChild(script);
  });
}

function setInFlightScriptLoad(
  cache: Map<string, Promise<void>>,
  cacheKey: string,
  promise: Promise<void>,
): Promise<void> {
  if (cache.size >= MAX_IN_FLIGHT_SCRIPT_LOADS && !cache.has(cacheKey)) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }

  const trackedPromise = promise.finally(() => {
    if (cache.get(cacheKey) === trackedPromise) {
      cache.delete(cacheKey);
    }
  });
  cache.set(cacheKey, trackedPromise);
  return trackedPromise;
}

function loadOnnxRuntime(scriptUrl: string, scriptNonce?: string): Promise<void> {
  if (getVADGlobal().ort) {
    return Promise.resolve();
  }

  const resolvedScriptUrl = resolveBrowserScriptUrl(scriptUrl);
  const resolvedNonce = resolveScriptNonce(scriptNonce);
  const cacheKey = `${resolvedScriptUrl}\n${resolvedNonce ?? ''}`;
  const cachedPromise = onnxRuntimeScriptPromises.get(cacheKey);

  if (cachedPromise) {
    return cachedPromise;
  }

  return setInFlightScriptLoad(
    onnxRuntimeScriptPromises,
    cacheKey,
    loadBrowserScript(resolvedScriptUrl, () => !!getVADGlobal().ort, resolvedNonce),
  );
}

function loadVADBrowserBundle(scriptUrl: string, scriptNonce?: string): Promise<void> {
  if (getVADGlobal().vad) {
    return Promise.resolve();
  }

  const resolvedScriptUrl = resolveBrowserScriptUrl(scriptUrl);
  const resolvedNonce = resolveScriptNonce(scriptNonce);
  const cacheKey = `${resolvedScriptUrl}\n${resolvedNonce ?? ''}`;
  const cachedPromise = vadScriptPromises.get(cacheKey);

  if (cachedPromise) {
    return cachedPromise;
  }

  return setInFlightScriptLoad(
    vadScriptPromises,
    cacheKey,
    loadBrowserScript(resolvedScriptUrl, () => !!getVADGlobal().vad, resolvedNonce),
  );
}

async function loadOptionalVAD(config: VADConfig): Promise<BrowserVADModule> {
  if (!getVADGlobal().vad) {
    await loadOnnxRuntime(
      config.onnxRuntimeScriptUrl || DEFAULT_ONNX_RUNTIME_SCRIPT_URL,
      config.scriptNonce,
    );
    await loadVADBrowserBundle(config.vadScriptUrl || DEFAULT_VAD_SCRIPT_URL, config.scriptNonce);
  }

  const vadModule = getVADGlobal().vad;
  if (!vadModule) {
    throw new Error('VAD browser bundle did not expose window.vad');
  }
  return vadModule;
}

// =============================================================================
// VAD ADAPTER (auto-detects @ricky0123/vad-web)
// =============================================================================

export class VADAdapter extends TypedEventEmitter<VADEvents> {
  private config: VADConfig;
  private vad: VADInstance | null = null;
  private available = false;
  private running = false;

  constructor(config?: VADConfig) {
    super();
    this.config = config || {};
  }

  /**
   * Attempt to initialize @ricky0123/vad-web.
   * Returns true if VAD is available, false if the package is not installed.
   */
  async initialize(): Promise<boolean> {
    try {
      const vadModule = await loadOptionalVAD(this.config);
      const MicVAD = vadModule.MicVAD || vadModule.default?.MicVAD;

      if (!MicVAD) {
        this.available = false;
        this.emit('initialized', { available: false });
        return false;
      }

      this.vad = await MicVAD.new({
        baseAssetPath: this.config.baseAssetPath || DEFAULT_BASE_ASSET_PATH,
        onnxWASMBasePath: this.config.onnxWASMBasePath || DEFAULT_ONNX_WASM_PATH,
        positiveSpeechThreshold:
          this.config.positiveSpeechThreshold ?? VAD_DEFAULTS.positiveSpeechThreshold,
        negativeSpeechThreshold:
          this.config.negativeSpeechThreshold ?? VAD_DEFAULTS.negativeSpeechThreshold,
        redemptionMs: this.config.redemptionMs ?? VAD_DEFAULTS.redemptionMs,
        minSpeechMs: this.config.minSpeechMs ?? VAD_DEFAULTS.minSpeechMs,
        preSpeechPadMs: this.config.preSpeechPadMs ?? VAD_DEFAULTS.preSpeechPadMs,

        onSpeechStart: () => {
          this.emit('speechStart', undefined);
        },
        onSpeechEnd: (audio: Float32Array) => {
          this.emit('speechEnd', { audio });
        },
        onVADMisfire: () => {
          this.emit('misfire', undefined);
        },
      });

      this.available = true;
      this.emit('initialized', { available: true });
      return true;
    } catch {
      // @ricky0123/vad-web not installed or failed to load
      this.available = false;
      this.emit('initialized', { available: false });
      return false;
    }
  }

  /**
   * Start listening for speech. No-op if VAD is not available.
   */
  start(): void {
    if (!this.available || !this.vad || this.running) return;
    this.vad.start();
    this.running = true;
  }

  /**
   * Pause VAD listening. Can be resumed with start().
   */
  pause(): void {
    if (!this.available || !this.vad || !this.running) return;
    this.vad.pause();
    this.running = false;
  }

  /**
   * Whether VAD is currently available (package loaded successfully).
   */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Whether VAD is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Destroy VAD and release resources.
   */
  destroy(): void {
    if (this.vad) {
      try {
        this.vad.pause();
        void this.vad.destroy?.();
      } catch {
        // Ignore cleanup errors
      }
      this.vad = null;
    }
    this.running = false;
    this.available = false;
  }
}

// =============================================================================
// MANUAL VAD ADAPTER (push-to-talk fallback)
// =============================================================================

/**
 * ManualVADAdapter — Push-to-talk fallback when @ricky0123/vad-web is not available.
 * Emits the same speechStart/speechEnd events, triggered by explicit UI actions.
 *
 * Usage:
 *   const manual = new ManualVADAdapter();
 *   // On button press:
 *   manual.startSpeech();
 *   // On button release (with captured audio):
 *   manual.endSpeech(capturedAudioFloat32);
 */
export class ManualVADAdapter extends TypedEventEmitter<VADEvents> {
  private speaking = false;

  /**
   * Trigger speech start (e.g., from UI button press).
   */
  startSpeech(): void {
    if (this.speaking) return;
    this.speaking = true;
    this.emit('speechStart', undefined);
  }

  /**
   * Trigger speech end with the captured audio data.
   * @param audio - The captured audio as Float32Array
   */
  endSpeech(audio: Float32Array): void {
    if (!this.speaking) return;
    this.speaking = false;
    this.emit('speechEnd', { audio });
  }

  /**
   * Whether the user is currently "speaking" (button held).
   */
  isSpeaking(): boolean {
    return this.speaking;
  }

  /**
   * No-op — included for interface compatibility with VADAdapter.
   */
  destroy(): void {
    this.speaking = false;
  }
}
