/**
 * Arch AI Audit Log Model
 *
 * Append-only operational telemetry for Arch AI sessions.
 * Event categories: llm_call, tool_execution, phase_transition,
 * user_action, build_event, editor_mode_event, error, system_event.
 *
 * 90-day TTL retention via MongoDB TTL index.
 * Tenant-isolated via tenantIsolationPlugin (defense-in-depth)
 * + explicit tenantId filters in every query (primary isolation).
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7, tenantIsolationPlugin } from '@agent-platform/database/mongo';

// ─── Constants ──────────────────────────────────────────────────────────

const DEFAULT_TTL_DAYS = 90;

function getTTLSeconds(): number {
  const raw = process.env.ARCH_AUDIT_LOG_TTL_DAYS;
  if (!raw) return DEFAULT_TTL_DAYS * 24 * 60 * 60;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed * 24 * 60 * 60
    : DEFAULT_TTL_DAYS * 24 * 60 * 60;
}

// ─── Document Interface ─────────────────────────────────────────────────

export interface IArchAuditLogRecord {
  _id: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  projectId?: string;
  category:
    | 'llm_call'
    | 'tool_execution'
    | 'phase_transition'
    | 'user_action'
    | 'build_event'
    | 'editor_mode_event'
    | 'error'
    | 'system_event';
  severity: 'info' | 'warning' | 'error' | 'critical';
  summary: string;
  detail: Record<string, unknown>;
  specialist?: string;
  phase?: string;
  durationMs?: number;
  tokens?: {
    input: number;
    output: number;
    total: number;
    estimatedCost: number;
  };
  timestamp: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ─────────────────────────────────────────────────────────────

const TokensSubSchema = new Schema(
  {
    input: { type: Number, required: true },
    output: { type: Number, required: true },
    total: { type: Number, required: true },
    estimatedCost: { type: Number, required: true },
  },
  { _id: false },
);

const ArchAuditLogSchema = new Schema<IArchAuditLogRecord>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    userId: { type: String, required: true },
    sessionId: { type: String, required: true },
    projectId: { type: String, default: null },
    category: {
      type: String,
      required: true,
      enum: [
        'llm_call',
        'tool_execution',
        'phase_transition',
        'user_action',
        'build_event',
        'editor_mode_event',
        'error',
        'system_event',
      ],
    },
    severity: {
      type: String,
      required: true,
      enum: ['info', 'warning', 'error', 'critical'],
    },
    summary: { type: String, required: true },
    detail: { type: Schema.Types.Mixed, required: true },
    specialist: { type: String, default: null },
    phase: { type: String, default: null },
    durationMs: { type: Number, default: null },
    tokens: { type: TokensSubSchema, default: null },
    timestamp: { type: Date, required: true },
  },
  { timestamps: true, collection: 'arch_audit_logs_v4' },
);

// ─── Plugins ────────────────────────────────────────────────────────────

ArchAuditLogSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ────────────────────────────────────────────────────────────

// Primary listing (admin page)
ArchAuditLogSchema.index({ tenantId: 1, timestamp: -1 });

// Session timeline
ArchAuditLogSchema.index({ tenantId: 1, sessionId: 1, timestamp: 1 });

// Category filter
ArchAuditLogSchema.index({ tenantId: 1, category: 1, timestamp: -1 });

// Error spotlight (severity filter)
ArchAuditLogSchema.index({ tenantId: 1, severity: 1, timestamp: -1 });

// Project scope (IN_PROJECT mode)
ArchAuditLogSchema.index({ tenantId: 1, projectId: 1, timestamp: -1 });

// TTL — 90-day retention (configurable via ARCH_AUDIT_LOG_TTL_DAYS)
ArchAuditLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: getTTLSeconds() });

// ─── Model ──────────────────────────────────────────────────────────────

export const ArchAuditLogModel =
  (mongoose.models.ArchAuditLogModel as mongoose.Model<IArchAuditLogRecord>) ||
  model<IArchAuditLogRecord>('ArchAuditLogModel', ArchAuditLogSchema);
