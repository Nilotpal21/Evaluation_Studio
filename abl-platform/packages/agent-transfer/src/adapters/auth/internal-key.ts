import type { ProviderConfig } from '../../config/schema.js';
import type { AuthCredentials } from '../../types.js';
import type { AuthProvider } from './interface.js';

export class InternalKeyAuth implements AuthProvider {
  async authenticate(config: ProviderConfig): Promise<AuthCredentials> {
    const apiKey = config.auth['apiKey'];
    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('InternalKeyAuth requires auth.apiKey to be a non-empty string');
    }
    return { type: 'internal_key', headers: { 'x-api-key': apiKey } };
  }
}
