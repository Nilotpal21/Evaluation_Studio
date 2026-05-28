import type { ProviderConfig } from '../../config/schema.js';
import type { AuthCredentials } from '../../types.js';
import type { AuthProvider } from './interface.js';

export class SessionHeaderAuth implements AuthProvider {
  async authenticate(config: ProviderConfig): Promise<AuthCredentials> {
    const sessionId = config.auth['sessionId'];
    const headerName = config.auth['headerName'];
    if (!sessionId || typeof sessionId !== 'string')
      throw new Error('SessionHeaderAuth requires auth.sessionId');
    const header = typeof headerName === 'string' ? headerName : 'X-LIVEAGENT-SESSION-KEY';
    return { type: 'session_header', token: sessionId, headers: { [header]: sessionId } };
  }
}
