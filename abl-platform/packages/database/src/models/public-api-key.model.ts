/**
 * Public API Key Model
 *
 * Stores public-facing API keys for client-side SDK access.
 * These keys have restricted permissions and optional origin
 * allowlisting for browser-based integrations.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface PublicApiKeyPermissions {
  chat: boolean;
  voice: boolean;
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function normalizePublicApiKeyAllowedOrigins(value: unknown): string[] | null {
  if (value == null) {
    return null;
  }

  if (Array.isArray(value)) {
    if (value.length === 1 && typeof value[0] === 'string') {
      const reparsed = normalizeStringArray(parseJson(value[0]));
      if (reparsed !== null) {
        return reparsed;
      }
    }

    return normalizeStringArray(value);
  }

  if (typeof value === 'string') {
    return normalizeStringArray(parseJson(value));
  }

  return null;
}

function normalizePermissionsRecord(value: unknown): PublicApiKeyPermissions | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const hasChat = typeof record.chat === 'boolean';
  const hasVoice = typeof record.voice === 'boolean';
  if (!hasChat && !hasVoice) {
    return null;
  }

  return {
    chat: hasChat ? (record.chat as boolean) : false,
    voice: hasVoice ? (record.voice as boolean) : false,
  };
}

export function normalizePublicApiKeyPermissions(value: unknown): PublicApiKeyPermissions | null {
  if (value == null) {
    return null;
  }

  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') {
    return normalizePublicApiKeyPermissions(value[0]);
  }

  if (typeof value === 'string') {
    return normalizePermissionsRecord(parseJson(value));
  }

  return normalizePermissionsRecord(value);
}

export interface IPublicApiKey {
  _id: string;
  projectId: string;
  tenantId?: string | null;
  keyPrefix: string;
  keyHash: string;
  name: string;
  allowedOrigins: string[] | null;
  permissions: PublicApiKeyPermissions | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  isActive: boolean;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const PublicApiKeySchema = new Schema<IPublicApiKey>(
  {
    _id: { type: String, default: uuidv7 },
    projectId: { type: String, required: true },
    // New keys should always set tenantId. Legacy keys may be missing it.
    tenantId: { type: String, required: false, default: null },
    keyPrefix: { type: String, required: true },
    keyHash: { type: String, required: true },
    name: { type: String, required: true },
    allowedOrigins: { type: [String], default: null, set: normalizePublicApiKeyAllowedOrigins },
    permissions: { type: Schema.Types.Mixed, default: null, set: normalizePublicApiKeyPermissions },
    lastUsedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'public_api_keys' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

PublicApiKeySchema.index({ keyHash: 1 }, { unique: true });
PublicApiKeySchema.index({ projectId: 1 });
PublicApiKeySchema.index({ tenantId: 1, projectId: 1 });

// ─── Plugins ─────────────────────────────────────────────────────────────

PublicApiKeySchema.plugin(tenantIsolationPlugin);

// ─── Model ───────────────────────────────────────────────────────────────

export const PublicApiKey =
  (mongoose.models.PublicApiKey as any) || model<IPublicApiKey>('PublicApiKey', PublicApiKeySchema);
