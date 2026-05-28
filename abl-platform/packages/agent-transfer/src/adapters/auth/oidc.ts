import type { ProviderConfig } from '../../config/schema.js';
import type { AuthCredentials } from '../../types.js';
import type { AuthProvider } from './interface.js';
import { assertAllowedUrl } from '../../security/ssrf-guard.js';

export class OIDCAuth implements AuthProvider {
  cacheTTL = 60 * 60 * 1000;
  private storedConfig: ProviderConfig | null = null;

  async authenticate(config: ProviderConfig): Promise<AuthCredentials> {
    this.storedConfig = config;
    const clientId = config.auth['clientId'];
    const clientSecret = config.auth['clientSecret'];
    const issuerUrl = config.auth['issuerUrl'];
    if (!clientId || typeof clientId !== 'string')
      throw new Error('OIDCAuth requires auth.clientId');
    if (!clientSecret || typeof clientSecret !== 'string')
      throw new Error('OIDCAuth requires auth.clientSecret');
    if (!issuerUrl || typeof issuerUrl !== 'string')
      throw new Error('OIDCAuth requires auth.issuerUrl');

    const discoveryUrl = `${(issuerUrl as string).replace(/\/$/, '')}/.well-known/openid-configuration`;
    await assertAllowedUrl(discoveryUrl);
    const discoveryResponse = await fetch(discoveryUrl);
    if (!discoveryResponse.ok)
      throw new Error(`OIDC discovery failed: ${discoveryResponse.status}`);
    const discoveryData = (await discoveryResponse.json()) as { token_endpoint: string };

    await assertAllowedUrl(discoveryData.token_endpoint);
    const response = await fetch(discoveryData.token_endpoint, {
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
      throw new Error(`OIDC token request failed: ${response.status} ${body}`);
    }
    const data = (await response.json()) as { access_token: string; expires_in?: number };
    const expiresIn = data.expires_in ?? 3600;
    return {
      type: 'oidc',
      token: data.access_token,
      headers: { authorization: `Bearer ${data.access_token}` },
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }

  async refresh(existing: AuthCredentials): Promise<AuthCredentials> {
    if (existing.expiresAt && existing.expiresAt > Date.now() + 30_000) {
      return existing;
    }
    if (!this.storedConfig) {
      return existing;
    }
    return this.authenticate(this.storedConfig);
  }
}
