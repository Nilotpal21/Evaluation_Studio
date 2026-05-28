/**
 * External KMS Provider (BYOP — Bring Your Own Provider)
 *
 * REST-based connector for tenant-provided external KMS endpoints.
 * Protocol:
 *   POST /generate-data-key  → { plaintext: base64, ciphertext: base64 }
 *   POST /wrap                → { ciphertext: base64 }
 *   POST /unwrap              → { plaintext: base64 }
 *   POST /encrypt             → { ciphertext: base64 }
 *   POST /decrypt             → { plaintext: base64 }
 *   GET  /health              → { status: 'healthy' | 'degraded' | 'unhealthy' }
 *   POST /keys                → { keyId, ... }
 *   GET  /keys/:keyId         → { keyId, state, ... }
 *
 * Auth methods: mTLS, OAuth2 client_credentials, API key, HMAC-SHA256
 *
 * Security constraints:
 *   - HTTPS required (TLS 1.2+)
 *   - 10s max timeout per request
 *   - 64KB max response size
 *   - Fail-closed on any error
 */

import { createHmac, randomBytes } from 'node:crypto';
import type {
  KMSProvider,
  GenerateDataKeyResult,
  WrapKeyResult,
  KMSKeyMetadata,
  KMSHealthStatus,
  KeyPurpose,
} from '../types.js';

// =============================================================================
// TYPES
// =============================================================================

export type ExternalAuthMethod = 'api-key' | 'oauth2' | 'hmac-sha256' | 'mtls';

export interface ExternalKMSProviderConfig {
  endpoint: string;
  authMethod: ExternalAuthMethod;
  /** API key header value (for api-key auth) */
  apiKey?: string;
  /** API key header name (default: X-API-Key) */
  apiKeyHeader?: string;
  /** OAuth2 client credentials */
  oauth2ClientId?: string;
  oauth2ClientSecret?: string;
  oauth2TokenUrl?: string;
  /** HMAC-SHA256 shared secret (hex) */
  hmacSecret?: string;
  /** mTLS cert/key (PEM) */
  tlsCert?: string;
  tlsKey?: string;
  tlsCa?: string;
  /** Request timeout in ms (default: 10000, max: 10000) */
  timeoutMs?: number;
  /** Max response size in bytes (default: 65536) */
  maxResponseBytes?: number;
}

interface OAuth2Token {
  accessToken: string;
  expiresAt: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;
const DEFAULT_API_KEY_HEADER = 'X-API-Key';

// =============================================================================
// EXTERNAL KMS PROVIDER
// =============================================================================

export class ExternalKMSProvider implements KMSProvider {
  readonly providerType = 'external' as const;

  private config: ExternalKMSProviderConfig;
  private initialized = false;
  private oauth2Token: OAuth2Token | null = null;
  private mtlsDispatcher: any | null = null;
  private timeoutMs: number;
  private maxResponseBytes: number;

  constructor(config: ExternalKMSProviderConfig) {
    this.config = config;
    this.timeoutMs = Math.min(config.timeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
    this.maxResponseBytes = Math.min(
      config.maxResponseBytes ?? MAX_RESPONSE_BYTES,
      MAX_RESPONSE_BYTES,
    );
  }

  async initialize(): Promise<void> {
    this.validateConfig();

    // Create mTLS dispatcher if configured (reuse across requests)
    if (this.config.authMethod === 'mtls') {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- runtime-only import, not bundled
      const { Agent: UndiciAgent } = await import(/* webpackIgnore: true */ 'undici' as string);
      this.mtlsDispatcher = new UndiciAgent({
        connect: {
          cert: this.config.tlsCert,
          key: this.config.tlsKey,
          ca: this.config.tlsCa || undefined,
        },
      });
    }

    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.oauth2Token = null;
    if (this.mtlsDispatcher) {
      await this.mtlsDispatcher.close();
      this.mtlsDispatcher = null;
    }
    this.initialized = false;
  }

  async healthCheck(): Promise<KMSHealthStatus> {
    const start = performance.now();
    try {
      const response = await this.request('GET', '/health');
      return {
        healthy: response.status === 'healthy',
        providerType: 'external',
        latencyMs: Math.round(performance.now() - start),
        message: response.message,
      };
    } catch (err) {
      return {
        healthy: false,
        providerType: 'external',
        latencyMs: Math.round(performance.now() - start),
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async generateDataKey(keyId: string): Promise<GenerateDataKeyResult> {
    this.assertInitialized();
    const response = await this.request('POST', '/generate-data-key', { keyId });
    return {
      plaintext: Buffer.from(response.plaintext, 'base64'),
      ciphertext: Buffer.from(response.ciphertext, 'base64'),
      keyId,
      keyVersion: response.keyVersion ?? 1,
    };
  }

  async wrapKey(keyId: string, plaintext: Buffer): Promise<WrapKeyResult> {
    this.assertInitialized();
    const response = await this.request('POST', '/wrap', {
      keyId,
      plaintext: plaintext.toString('base64'),
    });
    return {
      ciphertext: Buffer.from(response.ciphertext, 'base64'),
      keyId,
      keyVersion: response.keyVersion ?? 1,
    };
  }

  async unwrapKey(
    keyId: string,
    ciphertext: Buffer,
    keyVersion?: number,
    _keyVersionId?: string,
  ): Promise<Buffer> {
    this.assertInitialized();
    const response = await this.request('POST', '/unwrap', {
      keyId,
      ciphertext: ciphertext.toString('base64'),
      keyVersion,
    });
    return Buffer.from(response.plaintext, 'base64');
  }

  async encrypt(keyId: string, plaintext: Buffer): Promise<Buffer> {
    this.assertInitialized();
    const response = await this.request('POST', '/encrypt', {
      keyId,
      plaintext: plaintext.toString('base64'),
    });
    return Buffer.from(response.ciphertext, 'base64');
  }

  async decrypt(keyId: string, ciphertext: Buffer): Promise<Buffer> {
    this.assertInitialized();
    const response = await this.request('POST', '/decrypt', {
      keyId,
      ciphertext: ciphertext.toString('base64'),
    });
    return Buffer.from(response.plaintext, 'base64');
  }

  async createKey(purpose: KeyPurpose): Promise<KMSKeyMetadata> {
    this.assertInitialized();
    const response = await this.request('POST', '/keys', { purpose });
    return {
      keyId: response.keyId,
      state: response.state || 'active',
      purpose,
      algorithm: response.algorithm || 'AES-256-GCM',
      createdAt: new Date(response.createdAt || Date.now()),
      protectionLevel: response.protectionLevel || 'software-protected',
      rotationIntervalDays: response.rotationIntervalDays ?? 0,
    };
  }

  async describeKey(keyId: string): Promise<KMSKeyMetadata> {
    this.assertInitialized();
    const response = await this.request('GET', `/keys/${encodeURIComponent(keyId)}`);
    return {
      keyId: response.keyId,
      state: response.state || 'active',
      purpose: response.purpose || 'data-encryption',
      algorithm: response.algorithm || 'AES-256-GCM',
      createdAt: new Date(response.createdAt || Date.now()),
      protectionLevel: response.protectionLevel || 'software-protected',
      rotationIntervalDays: response.rotationIntervalDays ?? 0,
    };
  }

  async enableKeyRotation(keyId: string, intervalDays: number): Promise<void> {
    this.assertInitialized();
    await this.request('POST', `/keys/${encodeURIComponent(keyId)}/rotation`, { intervalDays });
  }

  async scheduleKeyDeletion(keyId: string, pendingWindowDays?: number): Promise<void> {
    this.assertInitialized();
    await this.request('POST', `/keys/${encodeURIComponent(keyId)}/schedule-deletion`, {
      pendingWindowDays: pendingWindowDays ?? 30,
    });
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private validateConfig(): void {
    const { endpoint, authMethod } = this.config;

    // HTTPS required
    if (!endpoint.startsWith('https://')) {
      throw new Error('External KMS endpoint must use HTTPS');
    }

    switch (authMethod) {
      case 'api-key':
        if (!this.config.apiKey) throw new Error('API key required for api-key auth');
        if (this.config.apiKeyHeader && /[\r\n\0]/.test(this.config.apiKeyHeader)) {
          throw new Error('apiKeyHeader must not contain CR, LF, or NUL characters');
        }
        break;
      case 'oauth2':
        if (
          !this.config.oauth2ClientId ||
          !this.config.oauth2ClientSecret ||
          !this.config.oauth2TokenUrl
        ) {
          throw new Error('OAuth2 client_credentials require clientId, clientSecret, and tokenUrl');
        }
        break;
      case 'hmac-sha256':
        if (!this.config.hmacSecret) throw new Error('HMAC secret required for hmac-sha256 auth');
        break;
      case 'mtls':
        if (!this.config.tlsCert || !this.config.tlsKey) {
          throw new Error('TLS cert and key required for mTLS auth');
        }
        break;
      default:
        throw new Error(`Unknown auth method: ${authMethod}`);
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error('ExternalKMSProvider not initialized — call initialize() first');
    }
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<any> {
    const url = `${this.config.endpoint}${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    // Apply auth headers
    await this.applyAuth(headers, method, path, body);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const fetchOptions: RequestInit & { dispatcher?: unknown } = {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      };

      // For mTLS: use undici Agent dispatcher with client cert/key
      if (this.mtlsDispatcher) {
        fetchOptions.dispatcher = this.mtlsDispatcher;
      }

      const response = await fetch(url, fetchOptions as RequestInit);

      // Check Content-Length before reading body
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > this.maxResponseBytes) {
        throw new Error(
          `Response too large: ${contentLength} bytes (max ${this.maxResponseBytes})`,
        );
      }

      const text = await response.text();
      if (text.length > this.maxResponseBytes) {
        throw new Error(`Response too large: ${text.length} bytes (max ${this.maxResponseBytes})`);
      }

      if (!response.ok) {
        throw new Error(
          `External KMS ${method} ${path} failed: ${response.status} ${text.slice(0, 200)}`,
        );
      }

      return JSON.parse(text);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(
          `External KMS request timed out after ${this.timeoutMs}ms: ${method} ${path}`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private sanitizeHeaderValue(value: string): string {
    return value.replace(/[\r\n\0]/g, '');
  }

  private async applyAuth(
    headers: Record<string, string>,
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<void> {
    switch (this.config.authMethod) {
      case 'api-key': {
        const headerName = this.sanitizeHeaderValue(
          this.config.apiKeyHeader || DEFAULT_API_KEY_HEADER,
        );
        headers[headerName] = this.sanitizeHeaderValue(this.config.apiKey!);
        break;
      }

      case 'oauth2': {
        const token = await this.getOAuth2Token();
        headers['Authorization'] = `Bearer ${this.sanitizeHeaderValue(token)}`;
        break;
      }

      case 'hmac-sha256': {
        const timestamp = Date.now().toString();
        const nonce = randomBytes(16).toString('hex');
        const payload = `${method}\n${path}\n${timestamp}\n${nonce}\n${body ? JSON.stringify(body) : ''}`;
        const signature = createHmac('sha256', Buffer.from(this.config.hmacSecret!, 'hex'))
          .update(payload)
          .digest('hex');

        headers['X-Signature'] = this.sanitizeHeaderValue(signature);
        headers['X-Timestamp'] = this.sanitizeHeaderValue(timestamp);
        headers['X-Nonce'] = this.sanitizeHeaderValue(nonce);
        break;
      }

      case 'mtls':
        // mTLS is handled at the TLS layer via undici Agent dispatcher in request().
        // No additional headers needed — client cert/key are sent during TLS handshake.
        break;
    }
  }

  private async getOAuth2Token(): Promise<string> {
    // Return cached token if still valid (with 30s buffer)
    if (this.oauth2Token && this.oauth2Token.expiresAt > Date.now() + 30_000) {
      return this.oauth2Token.accessToken;
    }

    const { oauth2ClientId, oauth2ClientSecret, oauth2TokenUrl } = this.config;
    const response = await fetch(oauth2TokenUrl!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: oauth2ClientId!,
        client_secret: oauth2ClientSecret!,
      }),
    });

    if (!response.ok) {
      throw new Error(`OAuth2 token request failed: ${response.status}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.oauth2Token = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    return this.oauth2Token.accessToken;
  }
}
