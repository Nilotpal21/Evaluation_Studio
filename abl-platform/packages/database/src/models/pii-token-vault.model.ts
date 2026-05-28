/**
 * PII Token Vault Model
 *
 * Durable encrypted storage for PII token originals. Normal message, trace,
 * and session stores keep redacted/tokenized text; this collection is the
 * narrow source of truth for future audited reveal workflows.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { ModelRegistry } from '../model-registry.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';

// ─── Constants ──────────────────────────────────────────────────────────

/** Default retention for revealable token originals. */
export const DEFAULT_PII_TOKEN_VAULT_RETENTION_DAYS = 90;

export const PII_TOKEN_SOURCE_SURFACES = [
  'input',
  'output',
  'tool',
  'trace',
  'message',
  'unknown',
] as const;

export type PIITokenSourceSurface = (typeof PII_TOKEN_SOURCE_SURFACES)[number];

// ─── Document Interface ─────────────────────────────────────────────────

export interface IPIITokenVault {
  _id: string;
  tenantId: string;
  projectId: string;
  sessionId: string;
  tokenId: string;
  token: string;
  piiType: string;
  patternName: string;
  /** Plaintext at the model boundary; encrypted by encryptionPlugin before storage. */
  encryptedOriginalValue: string;
  /** Detection confidence carried over from the source PIIDetection (0..1). */
  confidence?: number;
  /** Originating recognizer name (e.g. 'core-email', 'eu-iban'). */
  recognizer?: string;
  sourceSurface: PIITokenSourceSurface;
  sourceMessageId?: string;
  sourceTraceId?: string;
  sourceSpanId?: string;
  sourceFieldPath?: string;
  revealable: boolean;
  erasedAt?: Date | null;
  erasureReason?: string | null;
  expireAt: Date;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ─────────────────────────────────────────────────────────────

const PIITokenVaultSchema = new Schema<IPIITokenVault>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true, index: true },
    projectId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    tokenId: { type: String, required: true },
    token: { type: String, required: true },
    piiType: { type: String, required: true },
    patternName: { type: String, required: true },
    encryptedOriginalValue: { type: String, required: true },
    confidence: { type: Number, default: undefined },
    recognizer: { type: String, default: undefined },
    sourceSurface: {
      type: String,
      required: true,
      enum: PII_TOKEN_SOURCE_SURFACES,
      default: 'unknown',
    },
    sourceMessageId: { type: String, default: undefined },
    sourceTraceId: { type: String, default: undefined },
    sourceSpanId: { type: String, default: undefined },
    sourceFieldPath: { type: String, default: undefined },
    revealable: { type: Boolean, default: true },
    erasedAt: { type: Date, default: null },
    erasureReason: { type: String, default: null },
    expireAt: {
      type: Date,
      default: () =>
        new Date(Date.now() + DEFAULT_PII_TOKEN_VAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
      index: { expires: 0 },
    },
    _v: { type: Number, default: 1 },
  },
  {
    timestamps: true,
    collection: 'pii_token_vault',
  },
);

// ─── Indexes ────────────────────────────────────────────────────────────

PIITokenVaultSchema.index(
  { tenantId: 1, projectId: 1, sessionId: 1, tokenId: 1 },
  { unique: true },
);
PIITokenVaultSchema.index({ tenantId: 1, projectId: 1, sessionId: 1 });
PIITokenVaultSchema.index({ tenantId: 1, projectId: 1, sessionId: 1, revealable: 1 });
PIITokenVaultSchema.index({ tenantId: 1, projectId: 1, piiType: 1, createdAt: -1 });

// ─── Plugins ────────────────────────────────────────────────────────────

PIITokenVaultSchema.plugin(tenantIsolationPlugin);
PIITokenVaultSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedOriginalValue'],
  scopeFields: { tenantId: 'tenantId', projectId: 'projectId' },
});

// ─── Registry ───────────────────────────────────────────────────────────

ModelRegistry.registerModelDefinition('PIITokenVault', PIITokenVaultSchema, 'platform');

// ─── Model ──────────────────────────────────────────────────────────────

export const PIITokenVault =
  (mongoose.models.PIITokenVault as any) ||
  model<IPIITokenVault>('PIITokenVault', PIITokenVaultSchema);
