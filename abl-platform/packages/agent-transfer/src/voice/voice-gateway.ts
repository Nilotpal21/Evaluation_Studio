/**
 * Abstract Voice Gateway Interface
 *
 * Provides a provider-agnostic abstraction for voice gateway sessions.
 * Concrete implementations (KoreVG, AudioCodes, Twilio) live in the
 * runtime and register with the VoiceGatewayRegistry at startup.
 */
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('voice-gateway');

// ---------------------------------------------------------------------------
// Voice Gateway Session
// ---------------------------------------------------------------------------

/**
 * Represents an active voice call session on a specific gateway.
 * The runtime's KorevgSession implements this interface.
 */
export interface VoiceGatewaySession {
  /** Unique session identifier */
  readonly sessionId: string;

  /** Send a text message to be spoken via TTS */
  sendAgentMessage(text: string): void;

  /** Check if the session is still active */
  isActive(): boolean;

  /** Transfer the call (SIP REFER or PSTN dial) — optional capability */
  transferCall?(target: string, headers?: Record<string, string>): Promise<void>;

  /** Hang up the call — optional capability */
  hangup?(reason?: string): void;

  /** Send DTMF tones — optional capability */
  sendDTMF?(digits: string): void;

  /** Bridge a human agent into the active call. */
  dialAgent?(sipUri: string, options?: DialAgentOptions): Promise<void>;

  /** Play a TTS/system message to the caller. */
  playMessage?(text: string, options?: PlayMessageOptions): void;

  /**
   * Play a final TTS/system message and terminate the call in one provider-level operation.
   * Use this when the gateway needs a single redirect/command to avoid cutting off the audio.
   */
  playThenHangup?(text: string, reason?: string): Promise<void>;

  /**
   * Play a TTS prompt and collect DTMF input from the caller.
   * Returns the collected digits string, or null on timeout/error.
   */
  gatherDTMF?(prompt: string, options?: GatherDTMFOptions): Promise<string | null>;
}

export interface DialAgentOptions {
  sipHeaders?: Array<{ name: string; value: string }>;
  dialHeaders?: Record<string, string>;
  abortPrompts?: boolean;
}

export interface PlayMessageOptions {
  audioUrl?: string;
  bargeIn?: boolean;
  bargeInOnDTMF?: boolean;
}

export interface GatherDTMFOptions {
  /** Seconds to wait for input before timing out (default: 10) */
  timeout?: number;
  /** Number of digits to collect before returning (default: 1) */
  numDigits?: number;
}

// ---------------------------------------------------------------------------
// Voice Gateway
// ---------------------------------------------------------------------------

/**
 * A registered voice gateway provider.
 */
export interface VoiceGateway {
  /** Gateway name (e.g. 'korevg', 'audiocodes', 'twilio') */
  readonly name: string;

  /** Channel types this gateway handles */
  readonly supportedChannels: ReadonlySet<string>;

  /** Look up an active session by session ID */
  getSession(sessionId: string): VoiceGatewaySession | undefined;

  /** Check if the gateway is available and initialized */
  isAvailable(): boolean;
}

// ---------------------------------------------------------------------------
// Voice Gateway Registry
// ---------------------------------------------------------------------------

const MAX_GATEWAYS = 20;

/**
 * Registry for voice gateway providers.
 * The message bridge uses this to route agent messages to voice sessions
 * without directly importing concrete gateway implementations.
 */
export class VoiceGatewayRegistry {
  private readonly gateways = new Map<string, VoiceGateway>();
  private readonly channelIndex = new Map<string, string>();

  /**
   * Register a voice gateway.
   */
  register(gateway: VoiceGateway): void {
    if (this.gateways.size >= MAX_GATEWAYS) {
      log.warn('Voice gateway registry at capacity', { max: MAX_GATEWAYS });
      return;
    }

    this.gateways.set(gateway.name, gateway);

    for (const channel of gateway.supportedChannels) {
      this.channelIndex.set(channel, gateway.name);
    }

    log.info('Voice gateway registered', {
      name: gateway.name,
      channels: Array.from(gateway.supportedChannels),
    });
  }

  /**
   * Unregister a voice gateway.
   */
  unregister(name: string): void {
    const gateway = this.gateways.get(name);
    if (gateway) {
      for (const channel of gateway.supportedChannels) {
        if (this.channelIndex.get(channel) === name) {
          this.channelIndex.delete(channel);
        }
      }
      this.gateways.delete(name);
    }
  }

  /**
   * Get a gateway by name.
   */
  get(name: string): VoiceGateway | undefined {
    return this.gateways.get(name);
  }

  /**
   * Find a gateway that supports a given channel type.
   */
  getByChannel(channel: string): VoiceGateway | undefined {
    const name = this.channelIndex.get(channel);
    return name ? this.gateways.get(name) : undefined;
  }

  /**
   * Find a voice session across all gateways.
   */
  findSession(sessionId: string): VoiceGatewaySession | undefined {
    for (const gateway of this.gateways.values()) {
      if (!gateway.isAvailable()) continue;
      const session = gateway.getSession(sessionId);
      if (session) return session;
    }
    return undefined;
  }

  /**
   * List registered gateway names.
   */
  listNames(): string[] {
    return Array.from(this.gateways.keys());
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let registryInstance: VoiceGatewayRegistry | null = null;

export function getVoiceGatewayRegistry(): VoiceGatewayRegistry {
  if (!registryInstance) {
    registryInstance = new VoiceGatewayRegistry();
  }
  return registryInstance;
}
