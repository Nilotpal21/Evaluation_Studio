/**
 * SearchAI E2E Test Setup
 *
 * Shared server lifecycle for all SearchAI E2E scenarios.
 * Starts a real Express server with MongoDB, vector store, and all routes
 * including the unified /query and /discover endpoints.
 *
 * Usage in test files:
 *   import { getServer, SERVER_CONSTANTS } from './helpers/setup.js';
 *   const server = getServer();
 *   // server.baseUrl available after beforeAll
 */

import {
  startTestSearchServer,
  stopTestSearchServer,
  type TestSearchServer,
  INDEX_ID,
  KB_ID,
  TENANT_ID,
  PROJECT_ID,
} from '../../../helpers/search-server.js';

let serverInstance: TestSearchServer | null = null;

export const SERVER_CONSTANTS = {
  INDEX_ID,
  KB_ID,
  TENANT_ID,
  PROJECT_ID,
} as const;

export function getServer(): TestSearchServer {
  if (!serverInstance) {
    throw new Error('Test server not started. Call setupServer() in beforeAll.');
  }
  return serverInstance;
}

export async function setupServer(): Promise<TestSearchServer> {
  serverInstance = await startTestSearchServer();
  return serverInstance;
}

export async function teardownServer(): Promise<void> {
  if (serverInstance) {
    await stopTestSearchServer(serverInstance);
    serverInstance = null;
  }
}
