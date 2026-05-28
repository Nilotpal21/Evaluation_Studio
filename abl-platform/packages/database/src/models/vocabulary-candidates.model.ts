import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Interfaces ───────────────────────────────────────────────────────────

export interface ITermCandidate {
  term: string;
  frequency: number; // Total occurrences across all queries
  queryCount: number; // Number of distinct queries containing this term
  fieldAffinity: string | null; // Inferred canonical field (if any)
  coOccurrences: Array<{
    term: string;
    count: number;
  }>;
  sampleQueries: string[]; // Up to 5 sample queries containing this term
}

export interface IVocabularyCandidates {
  _id: string;
  tenantId: string;
  indexId: string; // SearchIndex._id
  knowledgeBaseId: string;
  totalQueriesAnalyzed: number;
  uniqueTermsExtracted: number;
  candidates: ITermCandidate[];
  analysisTimestamp: Date;
  expiresAt: Date; // TTL — MongoDB auto-deletes after this
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ───────────────────────────────────────────────────────────────

const TermCandidateSchema = new Schema<ITermCandidate>(
  {
    term: { type: String, required: true },
    frequency: { type: Number, required: true },
    queryCount: { type: Number, required: true },
    fieldAffinity: { type: String, default: null },
    coOccurrences: [
      {
        term: { type: String, required: true },
        count: { type: Number, required: true },
      },
    ],
    sampleQueries: { type: [String], default: [] },
  },
  { _id: false },
);

const VocabularyCandidatesSchema = new Schema<IVocabularyCandidates>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    indexId: { type: String, required: true },
    knowledgeBaseId: { type: String, required: true },
    totalQueriesAnalyzed: { type: Number, required: true },
    uniqueTermsExtracted: { type: Number, required: true },
    candidates: { type: [TermCandidateSchema], default: [] },
    analysisTimestamp: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'vocabulary_candidates' },
);

// ─── Plugins ──────────────────────────────────────────────────────────────

VocabularyCandidatesSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ──────────────────────────────────────────────────────────────

VocabularyCandidatesSchema.index({ tenantId: 1, indexId: 1 });
// TTL index: MongoDB automatically removes documents when expiresAt is reached
VocabularyCandidatesSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─── Model ────────────────────────────────────────────────────────────────

export const VocabularyCandidates =
  (mongoose.models.VocabularyCandidates as any) ||
  model<IVocabularyCandidates>('VocabularyCandidates', VocabularyCandidatesSchema);
