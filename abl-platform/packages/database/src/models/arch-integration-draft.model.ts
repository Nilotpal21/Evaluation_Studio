/**
 * Arch Integration Draft Model
 *
 * Durable project-scoped orchestration state for multi-step integration work
 * managed by Arch across tools, auth profiles, variables, and testing.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

export const ARCH_INTEGRATION_DRAFT_SOURCES = ['onboarding', 'in_project'] as const;
export type ArchIntegrationDraftSource = (typeof ARCH_INTEGRATION_DRAFT_SOURCES)[number];

export const ARCH_INTEGRATION_DRAFT_STATUSES = [
  'draft',
  'needs_input',
  'ready_to_test',
  'ready_to_apply',
  'complete',
  'archived',
  'failed',
] as const;
export type ArchIntegrationDraftStatus = (typeof ARCH_INTEGRATION_DRAFT_STATUSES)[number];

export interface IArchIntegrationDraftTestHistoryEntry {
  at: Date;
  status: 'pass' | 'fail';
  error?: string;
  sanitizedSampleInput?: string;
}

export interface IArchIntegrationDraft {
  _id: string;
  tenantId: string;
  projectId: string;
  sessionId: string | null;
  source: ArchIntegrationDraftSource;
  status: ArchIntegrationDraftStatus;
  title: string;
  providerKey: string | null;
  toolIds: string[];
  authProfileIds: string[];
  envVarKeys: string[];
  configVarKeys: string[];
  variableNamespaceIds: string[];
  targetAgentNames: string[];
  pendingSteps: string[];
  lastIntentSummary: string | null;
  createdBy: string;
  lastEditedBy: string | null;
  connectionIds: string[];
  lastTestStatus: 'pass' | 'fail' | 'pending' | null;
  lastTestAt: Date | null;
  lastTestError: string | null;
  testHistory: IArchIntegrationDraftTestHistoryEntry[];
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

const ArchIntegrationDraftSchema = new Schema<IArchIntegrationDraft>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    sessionId: { type: String, default: null },
    source: {
      type: String,
      enum: ARCH_INTEGRATION_DRAFT_SOURCES,
      required: true,
      default: 'in_project',
    },
    status: {
      type: String,
      enum: ARCH_INTEGRATION_DRAFT_STATUSES,
      required: true,
      default: 'draft',
    },
    title: { type: String, required: true, trim: true, maxlength: 255 },
    providerKey: { type: String, default: null, trim: true, maxlength: 255 },
    toolIds: { type: [String], default: [] },
    authProfileIds: { type: [String], default: [] },
    envVarKeys: { type: [String], default: [] },
    configVarKeys: { type: [String], default: [] },
    variableNamespaceIds: { type: [String], default: [] },
    targetAgentNames: { type: [String], default: [] },
    pendingSteps: { type: [String], default: [] },
    lastIntentSummary: { type: String, default: null, maxlength: 2000 },
    createdBy: { type: String, required: true },
    lastEditedBy: { type: String, default: null },
    connectionIds: { type: [String], default: [] },
    lastTestStatus: {
      type: String,
      enum: ['pass', 'fail', 'pending', null],
      default: null,
    },
    lastTestAt: { type: Date, default: null },
    lastTestError: { type: String, default: null },
    testHistory: {
      type: [
        {
          at: { type: Date, required: true },
          status: { type: String, enum: ['pass', 'fail'], required: true },
          error: { type: String },
          sanitizedSampleInput: { type: String },
          _id: false,
        },
      ],
      default: [],
    },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'arch_integration_drafts' },
);

// FIFO cap: keep only the 5 most recent testHistory entries.
// Runs in pre('validate') so the trim happens BEFORE schema validation,
// allowing callers to push a new entry without manually trimming first.
ArchIntegrationDraftSchema.pre('validate', function (next) {
  const doc = this as unknown as { testHistory?: IArchIntegrationDraftTestHistoryEntry[] };
  if (doc.testHistory && doc.testHistory.length > 5) {
    doc.testHistory.sort((a, b) => a.at.getTime() - b.at.getTime());
    doc.testHistory = doc.testHistory.slice(-5);
  }
  next();
});

ArchIntegrationDraftSchema.plugin(tenantIsolationPlugin);

ArchIntegrationDraftSchema.index({ tenantId: 1, projectId: 1, status: 1, updatedAt: -1 });
ArchIntegrationDraftSchema.index({ tenantId: 1, projectId: 1, sessionId: 1, updatedAt: -1 });

export const ArchIntegrationDraft =
  (mongoose.models.ArchIntegrationDraft as mongoose.Model<IArchIntegrationDraft>) ||
  model<IArchIntegrationDraft>('ArchIntegrationDraft', ArchIntegrationDraftSchema);
