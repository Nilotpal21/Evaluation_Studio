/**
 * Arch Session Attachment Model
 *
 * Maps Arch-facing blobIds to multimodal-service attachment records.
 * This keeps Arch session semantics stable even when the multimodal
 * service deduplicates content across sessions at the tenant level.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7, tenantIsolationPlugin } from '@agent-platform/database/mongo';

export interface IArchSessionAttachmentRecord {
  _id: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  projectId: string;
  phase: string;
  attachmentId: string;
  name: string;
  mediaType: string;
  size: number;
  contentHash: string | null;
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
  status: 'active' | 'excluded' | 'evicted' | 'deleted' | 'failed';
  createdAt: Date;
  updatedAt: Date;
}

const ArchSessionAttachmentSchema = new Schema<IArchSessionAttachmentRecord>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    userId: { type: String, required: true },
    sessionId: { type: String, required: true },
    projectId: { type: String, required: true },
    phase: { type: String, required: true },
    attachmentId: { type: String, required: true },
    name: { type: String, required: true },
    mediaType: { type: String, required: true },
    size: { type: Number, required: true },
    contentHash: { type: String, default: null },
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
    status: {
      type: String,
      required: true,
      enum: ['active', 'excluded', 'evicted', 'deleted', 'failed'],
      default: 'active',
    },
  },
  {
    timestamps: true,
    collection: 'arch_session_attachments_v4',
  },
);

ArchSessionAttachmentSchema.plugin(tenantIsolationPlugin);

ArchSessionAttachmentSchema.index({
  tenantId: 1,
  userId: 1,
  sessionId: 1,
  status: 1,
  createdAt: 1,
});
ArchSessionAttachmentSchema.index({ tenantId: 1, userId: 1, sessionId: 1, contentHash: 1 });
ArchSessionAttachmentSchema.index(
  { tenantId: 1, userId: 1, sessionId: 1, attachmentId: 1 },
  { unique: true },
);
ArchSessionAttachmentSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

ArchSessionAttachmentSchema.statics.deleteBySession = async function (
  sessionId: string,
  tenantId: string,
  userId: string,
): Promise<number> {
  const result = await this.deleteMany({ sessionId, tenantId, userId });
  return result.deletedCount ?? 0;
};

interface ArchSessionAttachmentMongooseModel extends mongoose.Model<IArchSessionAttachmentRecord> {
  deleteBySession(sessionId: string, tenantId: string, userId: string): Promise<number>;
}

export const ArchSessionAttachmentModel =
  (mongoose.models[
    'ArchSessionAttachmentModel'
  ] as unknown as ArchSessionAttachmentMongooseModel) ||
  model<IArchSessionAttachmentRecord, ArchSessionAttachmentMongooseModel>(
    'ArchSessionAttachmentModel',
    ArchSessionAttachmentSchema,
  );
