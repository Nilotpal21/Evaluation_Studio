import type { ProviderConfig } from '../../config/schema.js';
import type { AuthCredentials } from '../../types.js';
import type { AuthProvider } from './interface.js';

export class BasicAuth implements AuthProvider {
  async authenticate(config: ProviderConfig): Promise<AuthCredentials> {
    const username = config.auth['username'];
    const password = config.auth['password'];
    if (!username || typeof username !== 'string')
      throw new Error('BasicAuth requires auth.username to be a non-empty string');
    if (!password || typeof password !== 'string')
      throw new Error('BasicAuth requires auth.password to be a non-empty string');
    const encoded = Buffer.from(`${username}:${password}`).toString('base64');
    return { type: 'basic', headers: { authorization: `Basic ${encoded}` } };
  }
}
