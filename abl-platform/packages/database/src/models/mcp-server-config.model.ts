/**
 * MCP Server Config Model
 *
 * Stores MCP server configurations per project. Each config defines
 * how to connect to an MCP server (HTTP or SSE transport), with
 * optional encrypted environment variables for secrets.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IMCPServerConfig {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description: string | null;
  transport: 'http' | 'sse';
  url: string | null;
  encryptedEnv: string | null;
  authType: 'none' | 'bearer' | 'api_key' | 'custom_headers' | 'oauth2_client_credentials';
  encryptedAuthConfig: string | null;
  authProfileId: string | null;
  envProfileId: string | null;
  /** Plain-text per-call headers as JSON string (may contain {{session.X}} templates). Not encrypted. */
  headers: string | null;
  priority: number;
  tags: string | null;
  connectionTimeoutMs: number;
  requestTimeoutMs: number;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
  lastConnectionStatus: 'connected' | 'failed' | 'untested' | null;
  lastConnectionAt: Date | null;
  lastConnectionLatencyMs: number | null;
  lastConnectionToolCount: number | null;
  lastConnectionError: string | null;
  createdBy: string | null;
  modifiedBy: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const MCPServerConfigSchema = new Schema<IMCPServerConfig>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: null },
    transport: { type: String, required: true, enum: ['http', 'sse'] },
    url: { type: String, default: null },
    encryptedEnv: { type: String, default: null },
    authType: {
      type: String,
      enum: ['none', 'bearer', 'api_key', 'custom_headers', 'oauth2_client_credentials'],
      default: 'none',
    },
    encryptedAuthConfig: { type: String, default: null },
    authProfileId: { type: String, default: null },
    envProfileId: { type: String, default: null },
    headers: { type: String, default: null },
    priority: { type: Number, default: 0 },
    tags: { type: String, default: null },
    connectionTimeoutMs: { type: Number, default: 30000 },
    requestTimeoutMs: { type: Number, default: 30000 },
    autoReconnect: { type: Boolean, default: true },
    maxReconnectAttempts: { type: Number, default: 3 },
    lastConnectionStatus: {
      type: String,
      enum: ['connected', 'failed', 'untested'],
      default: null,
    },
    lastConnectionAt: { type: Date, default: null },
    lastConnectionLatencyMs: { type: Number, default: null },
    lastConnectionToolCount: { type: Number, default: null },
    lastConnectionError: { type: String, default: null },
    createdBy: { type: String, default: null },
    modifiedBy: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'mcp_server_configs' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

MCPServerConfigSchema.plugin(tenantIsolationPlugin);
MCPServerConfigSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedEnv', 'encryptedAuthConfig'],
  scope: 'project',
  scopeFields: { tenantId: 'tenantId', projectId: 'projectId' },
});

// ─── Indexes ─────────────────────────────────────────────────────────────

MCPServerConfigSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });
MCPServerConfigSchema.index({ tenantId: 1, projectId: 1, priority: -1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const MCPServerConfig =
  (mongoose.models.MCPServerConfig as any) ||
  model<IMCPServerConfig>('MCPServerConfig', MCPServerConfigSchema);
