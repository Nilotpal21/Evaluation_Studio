/**
 * Twilio Service - Twilio Voice API integration
 *
 * Handles Twilio access token generation, TwiML generation,
 * and media stream management.
 */

import crypto from 'crypto';
import { createLogger } from '@abl/compiler/platform';
import { getConfig } from '../../config/index.js';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';

const log = createLogger('twilio-service');

// =============================================================================
// TYPES
// =============================================================================

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  apiKey: string;
  apiSecret: string;
  twimlAppSid: string;
  trunkSid?: string;
}

export interface VoiceTokenOptions {
  identity: string;
  sessionId: string;
  ttl?: number; // Token TTL in seconds (default: 3600)
}

export interface TwiMLStreamOptions {
  streamUrl: string;
  sessionId: string;
  /** Additional parameters forwarded to the media stream handler */
  customParameters?: Record<string, string>;
}

// =============================================================================
// TWILIO SERVICE
// =============================================================================

export class TwilioService {
  private config: TwilioConfig | null = null;
  private basicAccountSid: string | null = null;
  private basicAuthToken: string | null = null;
  private twilio: any = null;

  constructor(explicitConfig?: TwilioConfig) {
    if (explicitConfig) {
      this.config = explicitConfig;
      log.info('Twilio configured with explicit credentials');
    } else {
      this.loadConfig();
    }
  }

  /**
   * Create from a decrypted TenantServiceInstance.
   */
  static fromCredentials(apiKey: string, config?: Record<string, unknown>): TwilioService {
    const twilioConfig: TwilioConfig = {
      accountSid: (config?.accountSid as string) || '',
      authToken: (config?.authToken as string) || '',
      apiKey: (config?.apiKeySid as string) || apiKey,
      apiSecret: (config?.apiKeySecret as string) || '',
      twimlAppSid: (config?.twimlAppSid as string) || '',
      trunkSid: (config?.trunkSid as string) || undefined,
    };
    return new TwilioService(twilioConfig);
  }

  private loadConfig(): void {
    // Prefer centralized config, fall back to process.env
    let accountSid: string | undefined;
    let authToken: string | undefined;
    let apiKey: string | undefined;
    let apiSecret: string | undefined;
    let twimlAppSid: string;

    const voice = getConfig().voice;
    accountSid = voice.twilio.accountSid;
    authToken = voice.twilio.authToken;
    apiKey = voice.twilio.apiKeySid;
    apiSecret = voice.twilio.apiKeySecret;
    twimlAppSid = voice.twilio.twimlAppSid || '';

    // Minimum requirements: account, auth, and API credentials
    // TwiML App SID is only needed for outbound calls
    if (accountSid && authToken && apiKey && apiSecret) {
      this.config = {
        accountSid,
        authToken,
        apiKey,
        apiSecret,
        twimlAppSid,
        trunkSid: voice.twilio.trunkSid,
      };
      if (!twimlAppSid) {
        log.warn('Twilio TwiML App SID not configured - outbound voice calls will be disabled');
        log.info('Set TWILIO_TWIML_APP_SID to enable full voice capabilities');
      } else {
        log.info('Twilio configuration loaded (full voice enabled)');
      }
    } else {
      // Store basic credentials for read-only operations (e.g., listing phone numbers)
      if (accountSid && authToken) {
        this.basicAccountSid = accountSid;
        this.basicAuthToken = authToken;
        log.info('Twilio basic credentials loaded (read-only operations available)');
      }
      log.warn('Twilio configuration incomplete - full voice features disabled');
      log.info(
        'Required for full voice: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_API_KEY, TWILIO_API_SECRET',
      );
    }
  }

  /**
   * Check if Twilio is fully configured (account, auth, API key/secret)
   */
  isConfigured(): boolean {
    return this.config !== null;
  }

  /**
   * Check if basic Twilio credentials are available (account SID + auth token only).
   * Sufficient for read-only operations like listing phone numbers.
   */
  isBasicConfigured(): boolean {
    return this.config !== null || (this.basicAccountSid !== null && this.basicAuthToken !== null);
  }

  private getAccountCredentials(): { accountSid: string; authToken: string } {
    if (this.config)
      return { accountSid: this.config.accountSid, authToken: this.config.authToken };
    if (this.basicAccountSid && this.basicAuthToken) {
      return { accountSid: this.basicAccountSid, authToken: this.basicAuthToken };
    }
    throw new AppError('Twilio not configured', { ...ErrorCodes.SERVICE_UNAVAILABLE });
  }

  /**
   * Generate an access token for client-side Twilio Device
   */
  async generateAccessToken(options: VoiceTokenOptions): Promise<string> {
    if (!this.config) {
      throw new AppError('Twilio not configured', { ...ErrorCodes.SERVICE_UNAVAILABLE });
    }

    // Lazy load twilio SDK
    if (!this.twilio) {
      this.twilio = await import('twilio');
    }

    const { AccessToken } = this.twilio.jwt;
    const { VoiceGrant } = AccessToken;

    const accessToken = new AccessToken(
      this.config.accountSid,
      this.config.apiKey,
      this.config.apiSecret,
      {
        identity: options.identity,
        ttl: options.ttl || 3600,
      },
    );

    // Grant voice capabilities
    const voiceGrantOptions: Record<string, unknown> = {
      incomingAllow: false, // We don't receive inbound calls
    };

    // Only add outgoing app if configured
    if (this.config.twimlAppSid) {
      voiceGrantOptions.outgoingApplicationSid = this.config.twimlAppSid;
    }

    const voiceGrant = new VoiceGrant(voiceGrantOptions);
    accessToken.addGrant(voiceGrant);

    log.debug('Generated Twilio access token', {
      identity: options.identity,
      sessionId: options.sessionId,
    });

    return accessToken.toJwt();
  }

  /**
   * Generate TwiML for connecting to media stream
   */
  generateStreamTwiML(options: TwiMLStreamOptions): string {
    // Build parameter XML — always include sessionId, plus any custom parameters
    const params: Record<string, string> = {
      sessionId: options.sessionId,
      ...options.customParameters,
    };
    const paramXml = Object.entries(params)
      .filter(([, v]) => v != null && v !== '')
      .map(
        ([k, v]) => `      <Parameter name="${this.escapeXml(k)}" value="${this.escapeXml(v)}" />`,
      )
      .join('\n');

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${options.streamUrl}">
${paramXml}
    </Stream>
  </Connect>
  <Pause length="60"/>
</Response>`;

    return twiml;
  }

  /**
   * Generate TwiML for saying a message (TTS fallback)
   */
  generateSayTwiML(message: string, voice = 'Polly.Amy'): string {
    const escapedMessage = this.escapeXml(message);
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}">${escapedMessage}</Say>
</Response>`;
  }

  /**
   * Generate TwiML for playing audio
   */
  generatePlayTwiML(audioUrl: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${audioUrl}</Play>
</Response>`;
  }

  /**
   * Search available phone numbers from Twilio's inventory.
   * Requires only basic credentials (accountSid + authToken).
   */
  async searchAvailableNumbers(options: {
    countryCode: string;
    numberType: 'local' | 'tollFree';
    areaCode?: string;
    contains?: string;
  }): Promise<
    Array<{ phoneNumber: string; friendlyName: string; region: string; isoCountry: string }>
  > {
    const { accountSid, authToken } = this.getAccountCredentials();

    if (!this.twilio) {
      this.twilio = await import('twilio');
    }

    const client = this.twilio.default(accountSid, authToken);
    const listOptions: Record<string, unknown> = { limit: 20 };
    if (options.areaCode) listOptions.areaCode = options.areaCode;
    if (options.contains) listOptions.contains = options.contains;

    const numbers = await client
      .availablePhoneNumbers(options.countryCode)
      [options.numberType].list(listOptions);

    return numbers.map(
      (n: { phoneNumber: string; friendlyName: string; region: string; isoCountry: string }) => ({
        phoneNumber: n.phoneNumber,
        friendlyName: n.friendlyName,
        region: n.region,
        isoCountry: n.isoCountry,
      }),
    );
  }

  /**
   * Purchase a phone number from Twilio.
   * Requires only basic credentials (accountSid + authToken).
   */
  async purchasePhoneNumber(
    phoneNumber: string,
  ): Promise<{ sid: string; phoneNumber: string; friendlyName: string }> {
    const { accountSid, authToken } = this.getAccountCredentials();

    if (!this.twilio) {
      this.twilio = await import('twilio');
    }

    const client = this.twilio.default(accountSid, authToken);

    const trunkSid = this.config?.trunkSid;
    const createParams: Record<string, string> = { phoneNumber };
    if (trunkSid) createParams.trunkSid = trunkSid;

    const purchased = await client.incomingPhoneNumbers.create(createParams);

    if (trunkSid) {
      log.info('Twilio phone number assigned to SIP trunk', {
        phoneNumber: purchased.phoneNumber,
        trunkSid,
      });
    } else {
      log.warn(
        'TWILIO_TRUNK_SID not configured — purchased number not assigned to SIP trunk; inbound calls will not route to voice gateway',
        {
          phoneNumber: purchased.phoneNumber,
        },
      );
    }

    return {
      sid: purchased.sid,
      phoneNumber: purchased.phoneNumber,
      friendlyName: purchased.friendlyName,
    };
  }

  /**
   * Release a purchased phone number back to Twilio.
   * Requires only basic credentials (accountSid + authToken).
   * 404 is treated as success (already released).
   */
  async releasePhoneNumber(sid: string): Promise<void> {
    const { accountSid, authToken } = this.getAccountCredentials();

    if (!this.twilio) {
      this.twilio = await import('twilio');
    }

    const client = this.twilio.default(accountSid, authToken);
    try {
      await client.incomingPhoneNumbers(sid).remove();
    } catch (err: any) {
      if (err?.status === 404) return; // already gone
      throw err;
    }
  }

  /**
   * List incoming phone numbers from the configured Twilio account
   */
  async listIncomingPhoneNumbers(): Promise<
    Array<{ sid: string; phoneNumber: string; friendlyName: string }>
  > {
    const { accountSid, authToken } = this.getAccountCredentials();

    if (!this.twilio) {
      this.twilio = await import('twilio');
    }

    const client = this.twilio.default(accountSid, authToken);
    const numbers = await client.incomingPhoneNumbers.list({ limit: 500 });
    return numbers.map((n: { sid: string; phoneNumber: string; friendlyName: string }) => ({
      sid: n.sid,
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName,
    }));
  }

  /**
   * Assign an existing (pre-owned) phone number to the configured SIP trunk.
   * Looks up the Twilio number SID by E.164 phone number, then calls update.
   * Returns null (no-op) if trunkSid is not configured.
   * Requires only basic credentials (accountSid + authToken).
   */
  async assignNumberToTrunk(phoneNumber: string): Promise<{ sid: string } | null> {
    const trunkSid = this.config?.trunkSid;
    if (!trunkSid) {
      log.warn('TWILIO_TRUNK_SID not configured — skipping trunk assignment', { phoneNumber });
      return null;
    }
    const { accountSid, authToken } = this.getAccountCredentials();
    if (!this.twilio) this.twilio = await import('twilio');
    const client = this.twilio.default(accountSid, authToken);

    const [number] = await client.incomingPhoneNumbers.list({ phoneNumber, limit: 1 });
    if (!number) throw new Error(`Phone number ${phoneNumber} not found in Twilio account`);

    await client.incomingPhoneNumbers(number.sid).update({ trunkSid });
    log.info('Twilio phone number assigned to SIP trunk', {
      phoneNumber,
      sid: number.sid,
      trunkSid,
    });
    return { sid: number.sid };
  }

  /**
   * Remove a phone number's SIP trunk assignment (unassign without releasing).
   * Requires only basic credentials (accountSid + authToken).
   * 404 is treated as success (already gone).
   */
  async unassignNumberFromTrunk(sid: string): Promise<void> {
    const { accountSid, authToken } = this.getAccountCredentials();
    if (!this.twilio) this.twilio = await import('twilio');
    const client = this.twilio.default(accountSid, authToken);
    try {
      await client.incomingPhoneNumbers(sid).update({ trunkSid: '' });
      log.info('Twilio phone number unassigned from SIP trunk', { sid });
    } catch (err: any) {
      if (err?.status === 404) return;
      throw err;
    }
  }

  /**
   * Validate Twilio webhook signature
   */
  async validateWebhookSignature(
    signature: string,
    url: string,
    params: Record<string, string>,
  ): Promise<boolean> {
    if (!this.config) {
      return false;
    }

    if (!this.twilio) {
      this.twilio = await import('twilio');
    }

    return this.twilio.validateRequest(this.config.authToken, signature, url, params);
  }

  // =========================================================================
  // MEDIA STREAM CONNECTION TOKENS
  // =========================================================================

  /** TTL for media stream connection tokens (5 minutes). */
  private static readonly MEDIA_STREAM_TOKEN_TTL_MS = 5 * 60 * 1000;

  /**
   * Generate a short-lived HMAC connection token for Twilio media stream
   * WebSocket upgrades. Include it as a `token` query parameter on the
   * `<Stream url="…">` URL in TwiML. The media handler validates it on
   * WebSocket upgrade to reject unauthenticated connections.
   *
   * Format: `{timestampMs}.{hmacHex}`
   */
  generateMediaStreamToken(): string {
    const { authToken } = this.getAccountCredentials();
    const ts = Date.now().toString();
    const hmac = crypto.createHmac('sha256', authToken).update(ts).digest('hex');
    return `${ts}.${hmac}`;
  }

  /**
   * Validate a media stream connection token produced by
   * {@link generateMediaStreamToken}. Returns `true` when the HMAC
   * matches and the token has not expired.
   */
  validateMediaStreamToken(
    token: string,
    ttlMs: number = TwilioService.MEDIA_STREAM_TOKEN_TTL_MS,
  ): boolean {
    let authToken: string;
    try {
      authToken = this.getAccountCredentials().authToken;
    } catch {
      return false;
    }

    const dotIndex = token.indexOf('.');
    if (dotIndex === -1) return false;

    const ts = token.substring(0, dotIndex);
    const sig = token.substring(dotIndex + 1);

    const timestamp = parseInt(ts, 10);
    if (Number.isNaN(timestamp)) return false;

    // Reject expired tokens (>= ensures a 0-TTL is treated as "already expired")
    if (Date.now() - timestamp >= ttlMs) return false;

    // Compute expected HMAC and compare using timing-safe equality
    const expected = crypto.createHmac('sha256', authToken).update(ts).digest('hex');
    if (sig.length !== expected.length) return false;

    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  }

  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

// Singleton instance
let twilioService: TwilioService | null = null;

export function getTwilioService(): TwilioService {
  if (!twilioService) {
    twilioService = new TwilioService();
  }
  return twilioService;
}
