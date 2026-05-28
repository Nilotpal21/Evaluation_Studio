/**
 * External Agent Config Types
 *
 * Normalized type auto-derived from IExternalAgentConfig via Normalized<T>.
 * Lookup result type for runtime agent resolution.
 */

import type { IExternalAgentConfig } from '@agent-platform/database/models';
import type { Normalized } from './normalize.js';

// ─── Normalized (auto-derived from Mongoose interface) ──────────────────────

export type NormalizedExternalAgentConfig = Normalized<IExternalAgentConfig>;

// ─── Lookup Result (projected for runtime agent resolution) ─────────────────

export interface ExternalAgentLookupResult {
  endpoint: string;
  protocol: string;
  authType: string;
  encryptedAuthConfig: string | null; // already decrypted by encryptionPlugin on read
}

// ─── Lookup Function Type ───────────────────────────────────────────────────

export type LookupExternalAgent = (
  tenantId: string,
  projectId: string,
  name: string,
) => Promise<ExternalAgentLookupResult | null>;

// ─── Connection Test Result ─────────────────────────────────────────────────

export interface ConnectionTestResult {
  reachable: boolean;
  agentCard?: unknown; // AgentCard from @a2a-js/sdk
  error?: string;
  latencyMs: number;
}

// ─── HTTP Response View (encryptedAuthConfig stripped) ──────────────────────

/**
 * Shape returned by external-agents HTTP routes (Studio + Runtime).
 *
 * Auth secret material (`encryptedAuthConfig`) is replaced with a boolean
 * `authConfigured` flag so the wire format never carries credentials.
 */
export interface ExternalAgentConfigView {
  id: string;
  name: string;
  displayName: string | null;
  endpoint: string;
  protocol: 'a2a' | 'rest';
  authType: 'none' | 'bearer' | 'api_key';
  authConfigured: boolean;
  lastDiscoveredCard: object | null;
  lastConnectionStatus: 'connected' | 'failed' | null;
  lastConnectionAt: string | null;
  lastConnectionLatencyMs: number | null;
  lastConnectionError: string | null;
  createdBy: string | null;
  modifiedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
