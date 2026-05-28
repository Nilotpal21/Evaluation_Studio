import type { ProviderConfig } from '../../config/schema.js';
import type { AuthCredentials } from '../../types.js';
import type { AuthProvider } from './interface.js';

export class BearerTokenAuth implements AuthProvider {
  async authenticate(config: ProviderConfig): Promise<AuthCredentials> {
    const token = config.auth['token'];
    if (!token || typeof token !== 'string') {
      throw new Error('BearerTokenAuth requires auth.token to be a non-empty string');
    }
    return { type: 'bearer', token, headers: { authorization: `Bearer ${token}` } };
  }
}
