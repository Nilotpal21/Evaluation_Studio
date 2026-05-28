/**
 * Session File Model — B03 Multimodality
 *
 * Stores file blobs uploaded during Arch AI sessions. Files are session-scoped
 * and cascade-deleted when the session is archived. Content can be stored inline
 * (Buffer for files <=4MB) or via GridFS (for files >4MB).
 *
 * Indexes:
 * - { sessionId, status } — primary query pattern (get active files for session)
 * - { sessionId, hash } — unique dedup (same content in same session = reuse)
 * - { tenantId, sessionId } — tenant isolation
 * - { createdAt } TTL 30 days — orphaned file cleanup
 */

import mongoose, { Schema, model } from 'mongoose';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface ISessionFile {
  _id: string;
  sessionId: string;
  tenantId: string;
  name: string;
  mediaType: string;
  size: number;
  hash: string;
  content: Buffer;
  metadata: {
    width?: number;
    height?: number;
    pageCount?: number;
    lineCount?: number;
    language?: string;
    endpointCount?: number;
    columns?: string[];
    rowCount?: number;
    tokenEstimate: number;
  };
  phase: string;
  status: 'active' | 'excluded' | 'evicted' | 'deleted' | 'failed';
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const SessionFileSchema = new Schema<ISessionFile>(
  {
    _id: { type: String, required: true },
    sessionId: { type: String, required: true },
    tenantId: { type: String, required: true },
    name: { type: String, required: true },
    mediaType: { type: String, required: true },
    size: { type: Number, required: true },
    hash: { type: String, required: true },
    content: { type: Buffer, required: true },
    metadata: {
      type: new Schema(
        {
          width: Number,
          height: Number,
          pageCount: Number,
          lineCount: Number,
          language: String,
          endpointCount: Number,
          columns: [String],
          rowCount: Number,
          tokenEstimate: { type: Number, required: true },
        },
        { _id: false },
      ),
      required: true,
    },
    phase: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ['active', 'excluded', 'evicted', 'deleted', 'failed'],
      default: 'active',
    },
  },
  {
    timestamps: true,
    collection: 'arch_session_files',
  },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

SessionFileSchema.index({ sessionId: 1, status: 1 });
SessionFileSchema.index({ sessionId: 1, hash: 1 }, { unique: true });
SessionFileSchema.index({ tenantId: 1, sessionId: 1 });
SessionFileSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 }); // 30-day TTL

// ─── Plugins ─────────────────────────────────────────────────────────────

SessionFileSchema.plugin(tenantIsolationPlugin);

// ─── Statics ─────────────────────────────────────────────────────────────

/**
 * Cascade delete: remove all session files when session is archived/deleted.
 * Called by session-service or route handler during session archival.
 * Defense-in-depth: TTL index provides backup cleanup for orphaned files.
 */
SessionFileSchema.statics.deleteBySession = async function (
  sessionId: string,
  tenantId: string,
): Promise<number> {
  const result = await this.deleteMany({ sessionId, tenantId });
  return result.deletedCount ?? 0;
};

// ─── Model ───────────────────────────────────────────────────────────────

export interface ISessionFileModel extends mongoose.Model<ISessionFile> {
  deleteBySession(sessionId: string, tenantId: string): Promise<number>;
}

export const SessionFile =
  (mongoose.models['SessionFile'] as unknown as ISessionFileModel) ||
  model<ISessionFile, ISessionFileModel>('SessionFile', SessionFileSchema);
