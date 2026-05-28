import type { ProviderConfig } from '../../config/schema.js';
import type { AuthCredentials } from '../../types.js';
import type { AuthProvider } from './interface.js';
import { assertAllowedUrl } from '../../security/ssrf-guard.js';

export class JWTAuth implements AuthProvider {
  cacheTTL = 55 * 60 * 1000;
  private storedConfig: ProviderConfig | null = null;

  async authenticate(config: ProviderConfig): Promise<AuthCredentials> {
    this.storedConfig = config;

    const token = config.auth['jwt'];
    if (token && typeof token === 'string') {
      return {
        type: 'jwt',
        token,
        headers: { authorization: `Bearer ${token}` },
        expiresAt: Date.now() + this.cacheTTL,
      };
    }

    const tokenUrl = config.auth['tokenUrl'];
    if (tokenUrl && typeof tokenUrl === 'string') {
      return this.fetchToken(config);
    }

    throw new Error('JWTAuth requires auth.jwt or auth.tokenUrl');
  }

  async refresh(existing: AuthCredentials): Promise<AuthCredentials> {
    if (!this.storedConfig) {
      return existing;
    }

    const staticJwt = this.storedConfig.auth['jwt'];
    if (staticJwt && typeof staticJwt === 'string') {
      return {
        type: 'jwt',
        token: staticJwt,
        headers: { authorization: `Bearer ${staticJwt}` },
        expiresAt: Date.now() + this.cacheTTL,
      };
    }

    const tokenUrl = this.storedConfig.auth['tokenUrl'];
    if (tokenUrl && typeof tokenUrl === 'string') {
      return this.fetchToken(this.storedConfig);
    }

    return existing;
  }

  private async fetchToken(config: ProviderConfig): Promise<AuthCredentials> {
    const tokenUrl = config.auth['tokenUrl'] as string;
    await assertAllowedUrl(tokenUrl);

    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    const clientId = config.auth['clientId'];
    const clientSecret = config.auth['clientSecret'];
    if (clientId && typeof clientId === 'string') {
      body.set('client_id', clientId);
    }
    if (clientSecret && typeof clientSecret === 'string') {
      body.set('client_secret', clientSecret);
    }

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`JWT token request failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as {
      access_token?: string;
      token?: string;
      expires_in?: number;
    };
    const accessToken = data.access_token ?? data.token;
    if (!accessToken) {
      throw new Error('JWT token endpoint returned no access_token or token field');
    }

    const expiresIn = data.expires_in ?? 3600;
    return {
      type: 'jwt',
      token: accessToken,
      headers: { authorization: `Bearer ${accessToken}` },
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }
}
