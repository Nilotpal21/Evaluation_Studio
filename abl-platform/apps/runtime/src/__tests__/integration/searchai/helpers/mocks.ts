/**
 * Shared vi.mock declarations for SearchAI E2E tests.
 *
 * IMPORTANT: Import this file BEFORE any other imports in test files.
 * vi.mock calls must be hoisted before the modules they mock are loaded.
 *
 * Usage in test files:
 *   import { vi } from 'vitest';
 *   import './helpers/mocks.js';  // Must be first
 */

import { vi } from 'vitest';

// Auth middleware bypass
vi.mock('../../../../search-ai-runtime/src/middleware/auth.js', () => ({
  authMiddleware: (_req: any, _res: any, next: any) => next(),
  unifiedAuth: (_req: any, _res: any, next: any) => next(),
}));

// Index ownership bypass
vi.mock('../../../../search-ai-runtime/src/middleware/verify-index-ownership.js', () => ({
  verifyIndexOwnership: (_req: any, _res: any, next: any) => next(),
}));

// Permission filter service - return pass-through filter
vi.mock('../../../../search-ai-runtime/src/services/query/permission-filter-service.js', () => ({
  getPermissionFilterService: () => ({
    buildPublicPermissionFilter: () => ({
      bool: {
        should: [{ match_all: {} }],
        minimum_should_match: 1,
      },
    }),
    buildUserPermissionFilter: async () => ({
      bool: {
        should: [{ match_all: {} }],
        minimum_should_match: 1,
      },
    }),
  }),
}));

// Redis client - no-op
vi.mock('../../../../search-ai-runtime/src/services/cache/redis-client.js', () => ({
  getGlobalRedisClient: () => null,
  getRedisHandle: () => null,
}));
