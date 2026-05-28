/**
 * Environment configuration for E2E tests.
 *
 * Reads from environment variables so the same specs run against
 * localhost or agents-dev.kore.ai (dev-login must be enabled on the target).
 *
 * Usage:
 *   TEST_BASE_URL=https://agents-dev.kore.ai npx playwright test --config e2e-env.config.ts
 *
 * @e2e-real — This file is part of the real E2E framework. No mocks allowed.
 */

import { getSdkBrowserRuntimeBaseUrl, getSdkBrowserStudioBaseUrl } from './sdk-browser-env';

export interface E2EEnv {
  baseUrl: string;
  searchAiUrl: string;
  runtimeUrl: string;
  searchAiRuntimeUrl: string;
  loginEmail: string;
  screenshotDir: string;
  tenantId: string;
  projectName: string;
  longTimeout: number;
  readonly isRemote: boolean;
}

export const env: E2EEnv = {
  /** Studio URL — the main UI entry point */
  baseUrl: process.env.TEST_BASE_URL || getSdkBrowserStudioBaseUrl(),

  /** SearchAI engine URL — for direct API calls (file upload has no Studio proxy) */
  searchAiUrl: process.env.TEST_SEARCHAI_URL || 'http://localhost:3005',

  /** Runtime URL — for direct runtime API calls */
  runtimeUrl: process.env.TEST_RUNTIME_URL || getSdkBrowserRuntimeBaseUrl(),

  /** SearchAI Runtime URL — for search/query calls */
  searchAiRuntimeUrl: process.env.TEST_SEARCHAI_RUNTIME_URL || 'http://localhost:3004',

  /** Dev login email — isolated E2E users should use @e2e-smoke.test */
  loginEmail: process.env.TEST_LOGIN_EMAIL || 'studio-playwright@e2e-smoke.test',

  /** Screenshot directory */
  screenshotDir: process.env.TEST_SCREENSHOT_DIR || 'e2e/screenshots',

  /** Tenant ID for API headers */
  tenantId: process.env.TEST_TENANT_ID || 'tenant-kore',

  /** Project name to select (if not set, picks first project with KBs) */
  projectName: process.env.TEST_PROJECT_NAME || '',

  /** Timeout for long operations like ingestion (ms) */
  longTimeout: Number(process.env.TEST_LONG_TIMEOUT) || 120_000,

  /** Whether this is a remote environment (affects upload routing) */
  get isRemote(): boolean {
    const hostname = new URL(this.baseUrl).hostname;
    return hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1';
  },
};
