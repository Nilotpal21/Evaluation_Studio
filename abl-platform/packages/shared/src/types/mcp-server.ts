/**
 * MCP Server Config Types
 *
 * Normalized type auto-derived from IMCPServerConfig via Normalized<T>.
 * API type strips internal fields and parses JSON string fields.
 */

import type { IMCPServerConfig } from '@agent-platform/database/models';
import type { Normalized } from './normalize.js';

// ─── Normalized (auto-derived from Mongoose interface) ──────────────────────

export type NormalizedMCPServerConfig = Normalized<IMCPServerConfig>;

// ─── API Response Type ──────────────────────────────────────────────────────

type MCPServerInternalFields =
  | 'tenantId'
  | 'projectId'
  | 'encryptedEnv'
  | 'encryptedAuthConfig'
  | '_v';

export type ApiMCPServerConfig = Omit<
  NormalizedMCPServerConfig,
  MCPServerInternalFields | 'tags' | 'headers'
> & {
  tags: string[];
  headers?: Record<string, string>;
  discoveredToolCount?: number;
};

// ─── IR Baking Types ────────────────────────────────────────────────────────

/**
 * Minimal shape required by buildMcpBindingFromProps for IR baking.
 * Satisfied by both RawMCPServerConfig (native driver, ciphertext) and
 * NormalizedMCPServerConfig (Mongoose, decrypted — legacy path only).
 */
export interface McpServerConfigForIR {
  name: string;
  transport: string;
  url: string | null | undefined;
  encryptedEnv: string | null | undefined;
  encryptedAuthConfig: string | null | undefined;
  authType: string | null | undefined;
  authProfileId?: string | null | undefined;
  envProfileId?: string | null | undefined;
  /** JSON string of headers object, or null */
  headers: string | null | undefined;
  connectionTimeoutMs: number | null | undefined;
  requestTimeoutMs: number | null | undefined;
}

/**
 * Raw MCP server config — encrypted fields carry DEK-envelope ciphertext,
 * NOT decrypted plaintext. Use ONLY for IR baking at compile time.
 * Do NOT expose via API responses or Studio UI.
 */
export interface RawMCPServerConfig extends McpServerConfigForIR {
  id: string;
  tenantId: string;
  projectId: string;
  /** DEK-envelope ciphertext — decrypted at runtime by InlineMcpClientProvider */
  encryptedEnv: string | null;
  /** DEK-envelope ciphertext — decrypted at runtime by InlineMcpClientProvider */
  encryptedAuthConfig: string | null;
  headers: string | null;
  authType: string | null;
  /** authProfileId for OAuth2 auth profiles — carried through but not used in IR baking yet */
  authProfileId: string | null;
  /** envProfileId for env-var profile resolution in MCP runtime registry */
  envProfileId: string | null;
}
