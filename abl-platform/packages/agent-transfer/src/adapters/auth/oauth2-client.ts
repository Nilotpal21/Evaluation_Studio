import type { ProviderConfig } from '../../config/schema.js';
import type { AuthCredentials } from '../../types.js';
import type { AuthProvider } from './interface.js';
import { assertAllowedUrl } from '../../security/ssrf-guard.js';

export class OAuth2ClientAuth implements AuthProvider {
  cacheTTL = 60 * 60 * 1000;
  private storedConfig: ProviderConfig | null = null;

  async authenticate(config: ProviderConfig): Promise<AuthCredentials> {
    this.storedConfig = config;
    return this.fetchToken(config);
  }

  async refresh(existing: AuthCredentials): Promise<AuthCredentials> {
    if (!this.storedConfig) {
      return existing;
    }
    return this.fetchToken(this.storedConfig);
  }

  private async fetchToken(config: ProviderConfig): Promise<AuthCredentials> {
    const clientId = config.auth['clientId'];
    const clientSecret = config.auth['clientSecret'];
    const tokenUrl = config.auth['tokenUrl'];
    if (!clientId || typeof clientId !== 'string')
      throw new Error('OAuth2ClientAuth requires auth.clientId');
    if (!clientSecret || typeof clientSecret !== 'string')
      throw new Error('OAuth2ClientAuth requires auth.clientSecret');
    if (!tokenUrl || typeof tokenUrl !== 'string')
      throw new Error('OAuth2ClientAuth requires auth.tokenUrl');

    await assertAllowedUrl(tokenUrl);
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OAuth2 token request failed: ${response.status} ${body}`);
    }
    const data = (await response.json()) as { access_token: string; expires_in?: number };
    const expiresIn = data.expires_in ?? 3600;
    return {
      type: 'oauth2',
      token: data.access_token,
      headers: { authorization: `Bearer ${data.access_token}` },
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }
}
