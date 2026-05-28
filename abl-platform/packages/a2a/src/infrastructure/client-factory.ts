// packages/a2a/src/infrastructure/client-factory.ts

import { A2AClient } from '@a2a-js/sdk/client';
import {
  createAuthenticatedA2AClient,
  type OutboundAuthConfig,
} from './authenticated-client-factory.js';

/**
 * Factory function to create an A2A SDK client.
 * Consumers should use this instead of importing @a2a-js/sdk directly,
 * keeping the SDK as an implementation detail of this package.
 */
export const createA2AClient = (baseUrl: string): A2AClient => new A2AClient(baseUrl);

/**
 * Factory function to create an A2A SDK client with auth headers.
 * Used when remote agent requires authentication (Bearer, API key).
 */
export const createA2AClientWithAuth = (baseUrl: string, auth: OutboundAuthConfig): A2AClient =>
  createAuthenticatedA2AClient(baseUrl, auth);
