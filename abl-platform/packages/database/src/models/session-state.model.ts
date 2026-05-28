/**
 * Session State Model
 *
 * Durable session snapshot for cold storage. When a Redis session expires
 * (idle > TTL), the session can be restored from this collection.
 * Stores compressed session state, per-thread data, compaction summaries,
 * and resolution keys for channel artifact lookups.
 *
 * Tenant-scoped via denormalized tenantId.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';

// ─── Embedded Interfaces ────────────────────────────────────────────────

export interface ISessionStateThread {
  threadId: string;
  agentName: string;
  status: 'active' | 'waiting' | 'completed' | 'escalated' | 'suspended' | 'human_agent';
  irSourceHash: string;
  parentThreadId?: string;
  forkPoint?: number;
  handoffFrom?: string;
  dataValues: Buffer;
  gatheredKeys: string[];
  state: Buffer;
  conversationHistory: Buffer;
  threadMetadata?: Buffer;
  lastCompactionSeq?: number;
  compactionSummary?: string;
}

export interface ISessionStateResolutionKey {
  channelId: string;
  artifactHash: string;
  ttlSeconds: number;
}

// ─── Document Interface ─────────────────────────────────────────────────

export interface ISessionState {
  _id: string;
  tenantId: string;
  projectId: string;
  userId: string | null;
  channel: string | null;
  agentName: string;
  version: number;
  stateData: Buffer;
  threads: ISessionStateThread[];
  activeThreadId: string;
  threadStack: string[];
  headSeq: number;
  lastCompactionSeq: number;
  compactionSummary?: string;
  pendingAsyncTasks: string[];
  irData?: Buffer;
  compilationData?: Buffer;
  resolutionKeys: ISessionStateResolutionKey[];
  encryptedFields: string[];
  parentSessionId?: string;
  forkPoint?: number;
  expiresAt: Date;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Embedded Schemas ───────────────────────────────────────────────────

const SessionStateThreadSchema = new Schema<ISessionStateThread>(
  {
    threadId: { type: String, required: true },
    agentName: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ['active', 'waiting', 'completed', 'escalated', 'suspended', 'human_agent'],
    },
    irSourceHash: { type: String, required: true },
    parentThreadId: { type: String },
    forkPoint: { type: Number },
    handoffFrom: { type: String },
    dataValues: { type: Buffer, required: true },
    gatheredKeys: { type: [String], default: [] },
    state: { type: Buffer, required: true },
    conversationHistory: { type: Buffer, required: true },
    threadMetadata: { type: Buffer },
    lastCompactionSeq: { type: Number },
    compactionSummary: { type: String },
  },
  { _id: false },
);

const ResolutionKeySchema = new Schema<ISessionStateResolutionKey>(
  {
    channelId: { type: String, required: true },
    artifactHash: { type: String, required: true },
    ttlSeconds: { type: Number, required: true },
  },
  { _id: false },
);

// ─── Schema ─────────────────────────────────────────────────────────────

const SessionStateSchema = new Schema<ISessionState>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    userId: { type: String, default: null },
    channel: { type: String, default: null },
    agentName: { type: String, required: true },
    version: { type: Number, required: true, default: 0 },
    stateData: { type: Buffer, required: true },
    threads: { type: [SessionStateThreadSchema], default: [] },
    activeThreadId: { type: String, required: true },
    threadStack: { type: [String], default: [] },
    headSeq: { type: Number, default: 0 },
    lastCompactionSeq: { type: Number, default: -1 },
    compactionSummary: { type: String },
    pendingAsyncTasks: { type: [String], default: [] },
    irData: { type: Buffer },
    compilationData: { type: Buffer },
    resolutionKeys: { type: [ResolutionKeySchema], default: [] },
    encryptedFields: { type: [String], default: [] },
    parentSessionId: { type: String },
    forkPoint: { type: Number },
    expiresAt: { type: Date, required: true },
    lastActivityAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'session_states' },
);

// ─── Plugins ────────────────────────────────────────────────────────────

SessionStateSchema.plugin(tenantIsolationPlugin);
SessionStateSchema.plugin(encryptionPlugin, {
  // Top-level Buffers are encrypted at the application layer.
  // Per-thread Buffers
  // (threads[].dataValues, threads[].state, threads[].conversationHistory, threads[].threadMetadata)
  // are in an embedded array which the plugin cannot encrypt directly — they rely on
  // MongoDB's at-rest encryption (encrypted storage engine) for protection.
  // The critical session state IS covered via stateData which contains all data values.
  // irData and compilationData are reserved schema fields for future IR persistence.
  // They are currently unwritten by the upsert path and must NOT be listed in
  // fieldsToEncrypt — listing them causes unnecessary encryption overhead on every save.
  fieldsToEncrypt: ['stateData'],
  scope: 'project',
  scopeFields: { tenantId: 'tenantId', projectId: 'projectId' },
});

// ─── Indexes ────────────────────────────────────────────────────────────

SessionStateSchema.index({ tenantId: 1, _id: 1 });
SessionStateSchema.index({ tenantId: 1, projectId: 1, lastActivityAt: -1 });
SessionStateSchema.index({ tenantId: 1, projectId: 1, userId: 1, channel: 1, lastActivityAt: -1 });
SessionStateSchema.index(
  { tenantId: 1, 'resolutionKeys.artifactHash': 1 },
  { partialFilterExpression: { 'resolutionKeys.0': { $exists: true } } },
);

// TTL index: auto-expire cold sessions after expiresAt
SessionStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─── Model ──────────────────────────────────────────────────────────────

export const SessionState =
  (mongoose.models.SessionState as mongoose.Model<ISessionState>) ||
  model<ISessionState>('SessionState', SessionStateSchema);
