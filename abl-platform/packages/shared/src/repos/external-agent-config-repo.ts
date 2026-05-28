/**
 * External Agent Config Repository
 *
 * MongoDB CRUD operations for external agent configurations.
 * Used by: Studio (CRUD routes), Runtime (agent resolution via LookupExternalAgent)
 */

import type { IExternalAgentConfig } from '@agent-platform/database/models';
import { normalizeDocument } from '../utils/normalize.js';
import type {
  NormalizedExternalAgentConfig,
  ExternalAgentLookupResult,
  ConnectionTestResult,
} from '../types/external-agent.js';

// Re-export types so callers can import from the repos barrel
export type {
  NormalizedExternalAgentConfig,
  ExternalAgentLookupResult,
  LookupExternalAgent,
  ConnectionTestResult,
} from '../types/external-agent.js';

function normalize(doc: IExternalAgentConfig | null): NormalizedExternalAgentConfig | null {
  return normalizeDocument(doc) as NormalizedExternalAgentConfig | null;
}

// ─── Find ─────────────────────────────────────────────────────────────────

export async function findExternalAgentConfigById(
  id: string,
  tenantId: string,
  projectId: string,
): Promise<NormalizedExternalAgentConfig | null> {
  const { ExternalAgentConfig } = await import('@agent-platform/database/models');
  const doc = await ExternalAgentConfig.findOne({ _id: id, tenantId, projectId }).lean();
  return normalize(doc);
}

export async function findExternalAgentConfigsByProject(
  tenantId: string,
  projectId: string,
): Promise<NormalizedExternalAgentConfig[]> {
  const { ExternalAgentConfig } = await import('@agent-platform/database/models');
  const docs = await ExternalAgentConfig.find({ tenantId, projectId })
    .sort({ createdAt: -1 })
    .lean();
  return docs.map((doc: IExternalAgentConfig) => {
    const normalized = normalize(doc);
    /* v8 ignore start */
    if (!normalized) {
      throw new Error('Failed to normalize external agent config - data integrity error');
    }
    /* v8 ignore stop */
    return normalized;
  });
}

export async function findExternalAgentConfigByName(
  tenantId: string,
  projectId: string,
  name: string,
): Promise<ExternalAgentLookupResult | null> {
  const { ExternalAgentConfig } = await import('@agent-platform/database/models');
  const doc = await ExternalAgentConfig.findOne({ tenantId, projectId, name }).lean();
  if (!doc) return null;
  return {
    endpoint: doc.endpoint,
    protocol: doc.protocol,
    authType: doc.authType,
    encryptedAuthConfig: doc.encryptedAuthConfig,
  };
}

// ─── Create ───────────────────────────────────────────────────────────────

export interface CreateExternalAgentInput {
  tenantId: string;
  projectId: string;
  name: string;
  displayName?: string | null;
  endpoint: string;
  protocol: 'a2a' | 'rest';
  authType: 'none' | 'bearer' | 'api_key';
  encryptedAuthConfig?: string | null;
  createdBy?: string | null;
}

export async function createExternalAgentConfig(
  data: CreateExternalAgentInput,
): Promise<NormalizedExternalAgentConfig> {
  const { ExternalAgentConfig } = await import('@agent-platform/database/models');
  const doc = await ExternalAgentConfig.create(data);
  const normalized = normalize(doc.toObject());
  /* v8 ignore start */
  if (!normalized) {
    throw new Error(
      'Failed to normalize newly created external agent config - data integrity error',
    );
  }
  /* v8 ignore stop */
  return normalized;
}

// ─── Update ───────────────────────────────────────────────────────────────

export interface UpdateExternalAgentInput {
  displayName?: string | null;
  endpoint?: string;
  protocol?: 'a2a' | 'rest';
  authType?: 'none' | 'bearer' | 'api_key';
  encryptedAuthConfig?: string | null;
  modifiedBy?: string | null;
}

export async function updateExternalAgentConfig(
  id: string,
  tenantId: string,
  projectId: string,
  patch: UpdateExternalAgentInput,
): Promise<NormalizedExternalAgentConfig | null> {
  const { ExternalAgentConfig } = await import('@agent-platform/database/models');
  // Use findOne + save() so the encryption plugin's pre-save hook fires
  const doc = await ExternalAgentConfig.findOne({ _id: id, tenantId, projectId });
  if (!doc) return null;
  for (const [key, value] of Object.entries(patch)) {
    doc.set(key, value);
  }
  await doc.save();
  return normalize(doc.toObject());
}

// ─── Connection Status ───────────────────────────────────────────────────

export interface ConnectionStatusPatch {
  lastConnectionStatus: 'connected' | 'failed';
  lastConnectionAt: Date;
  lastConnectionLatencyMs: number;
  lastDiscoveredCard?: object | null;
  lastConnectionError?: string | null;
}

export async function patchExternalAgentConnectionStatus(
  id: string,
  tenantId: string,
  projectId: string,
  status: ConnectionStatusPatch,
): Promise<NormalizedExternalAgentConfig | null> {
  const { ExternalAgentConfig } = await import('@agent-platform/database/models');
  // Use findOne + save() so the encryption plugin's pre-save hook fires
  const doc = await ExternalAgentConfig.findOne({ _id: id, tenantId, projectId });
  if (!doc) return null;
  for (const [key, value] of Object.entries(status)) {
    doc.set(key, value);
  }
  await doc.save();
  return normalize(doc.toObject());
}

// ─── Delete ───────────────────────────────────────────────────────────────

export async function deleteExternalAgentConfig(
  id: string,
  tenantId: string,
  projectId: string,
): Promise<boolean> {
  const { ExternalAgentConfig } = await import('@agent-platform/database/models');
  const result = await ExternalAgentConfig.deleteOne({ _id: id, tenantId, projectId });
  return result.deletedCount > 0;
}

// ─── Connection Test ─────────────────────────────────────────────────────

/**
 * Auth config shape mirrored from `@agent-platform/a2a`'s `OutboundAuthConfig`.
 *
 * Defined inline rather than imported so the shared package keeps zero runtime
 * or type dependency on the a2a package — preserves the no-circular-deps
 * boundary that already governs `TestConnectionDeps.createClient` injection.
 */
export interface ExternalAgentAuthConfig {
  type: 'bearer' | 'api_key';
  value: string;
  /** Header name. Default: 'Authorization' for bearer, 'X-API-Key' for api_key. */
  header?: string;
}

/**
 * Dependencies for testExternalAgentConnection.
 *
 * Injected by the caller (typically the runtime route handler) to avoid
 * a circular dependency between @agent-platform/shared and @agent-platform/a2a.
 */
export interface TestConnectionDeps {
  /** discoverAgent use-case from @agent-platform/a2a */
  discoverAgent: (
    params: { endpoint: string; tenantId: string; allowPrivate?: boolean },
    deps: {
      tracing: {
        traceOutbound: (...args: unknown[]) => void;
        traceInbound: (...args: unknown[]) => void;
      };
      validator: { validate: (url: string, allowPrivate?: boolean) => void };
      createClient: (baseUrl: string) => unknown;
    },
  ) => Promise<unknown>;
  /** SsrfEndpointValidator constructor from @agent-platform/a2a */
  createValidator: () => { validate: (url: string, allowPrivate?: boolean) => void };
  /** createA2AClient factory from @agent-platform/a2a */
  createClient: (baseUrl: string) => unknown;
  /**
   * Auth-aware client factory (`createA2AClientWithAuth` from `@agent-platform/a2a`).
   * Required only when `authConfig` is passed to `testExternalAgentConnection`.
   * Optional for backward compatibility with callers that never test authenticated
   * endpoints.
   */
  createClientWithAuth?: (baseUrl: string, auth: ExternalAgentAuthConfig) => unknown;
}

/**
 * Test connectivity to an external agent endpoint.
 *
 * Uses injected A2A dependencies (discoverAgent, SsrfEndpointValidator, createA2AClient)
 * to fetch the remote agent card. Returns a structured result with reachability,
 * latency, and any error details.
 *
 * When `authConfig` is provided, the discover call uses the injected
 * `createClientWithAuth` factory so the upstream A2A endpoint sees the configured
 * Bearer / API key on the wire. Without this, a misconfigured token would be
 * invisible — every test_connection would succeed against the public agent-card
 * route while every real handoff would 401.
 */
export async function testExternalAgentConnection(
  endpoint: string,
  tenantId: string,
  allowPrivate: boolean,
  deps: TestConnectionDeps,
  authConfig?: ExternalAgentAuthConfig,
): Promise<ConnectionTestResult> {
  const validator = deps.createValidator();

  // Choose auth-aware factory when caller supplies credentials AND the runtime
  // wired the optional createClientWithAuth dep. The fallback path matches the
  // legacy unauthenticated behaviour exactly so callers without authConfig are
  // unaffected.
  const createClient: (baseUrl: string) => unknown =
    authConfig && deps.createClientWithAuth
      ? (baseUrl: string) => deps.createClientWithAuth!(baseUrl, authConfig)
      : deps.createClient;

  // No-op tracing adapter — connection test does not need distributed tracing
  const noopTracing = {
    traceOutbound: () => {},
    traceInbound: () => {},
  };

  const start = Date.now();
  try {
    const cardPromise = deps.discoverAgent(
      { endpoint, tenantId, allowPrivate },
      { tracing: noopTracing, validator, createClient },
    );

    // Race against a 5-second timeout
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Connection test timed out after 5000ms'));
      }, 5000);
      // Unref so the timer doesn't keep Node alive
      if (typeof timer === 'object' && 'unref' in timer) {
        timer.unref();
      }
    });

    const agentCard = await Promise.race([cardPromise, timeoutPromise]);
    const latencyMs = Date.now() - start;
    return { reachable: true, agentCard, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - start;
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { reachable: false, error: errorMessage, latencyMs };
  }
}
