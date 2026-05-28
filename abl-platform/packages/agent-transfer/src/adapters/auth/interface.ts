/**
 * AuthProvider Interface
 */
import type { ProviderConfig } from '../../config/schema.js';
import type { AuthCredentials } from '../../types.js';

export interface AuthProvider {
  authenticate(config: ProviderConfig): Promise<AuthCredentials>;
  refresh?(existing: AuthCredentials): Promise<AuthCredentials>;
  cacheTTL?: number;
}
