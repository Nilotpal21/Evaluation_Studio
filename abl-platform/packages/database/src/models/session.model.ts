/**
 * Session Model
 *
 * Represents a conversation session between an end-user and the agent
 * platform. Tracks lifecycle, channel, billing metrics, and agent context.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Disposition Values ──────────────────────────────────────────────────

/** Well-known disposition values for session outcome categorization */
export type SessionDisposition = 'completed' | 'abandoned' | 'escalated' | 'timeout' | 'unengaged';

// ─── Document Interface ──────────────────────────────────────────────────

/** SDK principal information for omnichannel session tracking */
export interface ISessionSdkPrincipal {
  channelId: string;
  permissions: string[];
  grantedCapabilities: string[];
}

/** Verified identity information attached to a session */
export interface ISessionVerifiedIdentity {
  contactId: string;
  method: string;
  strength: number;
  verifiedAt: Date;
}

/** Participant attached to an omnichannel live session */
export interface ISessionAttachedParticipant {
  participantId: string;
  channel: string;
  mode: 'active' | 'observe';
  interactive: boolean;
  attachedAt: Date;
  detachedAt: Date | null;
}

/** Live sync state for omnichannel sessions */
export interface ISessionLiveSyncState {
  status: 'inactive' | 'active' | 'ended';
  joinMode: 'prompt' | 'auto_link';
  transcriptMode: 'final_only';
  lastSequence: number;
}

export type StudioSessionSource = {
  type: 'studio';
  workspaceUserId?: string | null;
};

export type PublicSessionSource = {
  type: 'public';
  endUserId?: string | null;
  contactId?: string | null;
};

export type ChannelSessionSource = {
  type: 'channel';
  channelId?: string | null;
  endUserId?: string | null;
  contactId?: string | null;
};

export type SessionSource = StudioSessionSource | PublicSessionSource | ChannelSessionSource;

/**
 * Known session purpose — orthogonal to SessionSource (which captures WHERE
 * traffic entered). `knownSource` captures WHY the session exists.
 *
 * - `production` — real end-user traffic (default when absent)
 * - `eval`       — created by the pipeline-engine's eval runner
 * - `synthetic`  — created by a cost-estimator or load-test harness
 */
export type KnownSessionSource = 'production' | 'eval' | 'synthetic';

export interface ISession {
  _id: string;
  tenantId: string;
  projectId: string;
  contactId: string | null;
  callerNumber: string | null;
  initiatedById: string | null;
  customerId: string | null;
  anonymousId: string | null;
  currentAgent: string;
  agentVersion: string | null;
  environment: string;
  entryAgentName: string | null;
  workflowId: string | null;
  workflowStepId: string | null;
  parentId: string | null;
  channel: string;
  channelHistory: string[];
  status: string;
  disposition: string | null;
  dispositionCode: string | null;
  outcome:
    | 'contained'
    | 'contained_resolved'
    | 'contained_partial'
    | 'contained_unresolved'
    | 'escalated'
    | 'abandoned'
    | null;
  context: any;
  metadata: any;
  deploymentId: string | null;
  /** SHA-256 hashed channel artifact for session resolution */
  channelArtifact: string | null;
  /** Type of the channel artifact (caller_id, cookie, device_id, etc.) */
  channelArtifactType: string | null;
  /** Identity tier: 0=anonymous, 1=unverified, 2=verified */
  identityTier: number;
  /** How the user's identity was verified */
  verificationMethod: string | null;
  /** SDK channel ID for channel-scoped operations */
  channelId: string | null;
  /** Unique principal ID for this session (UUIDv7) */
  sessionPrincipalId: string | null;
  /** SDK principal information for omnichannel tracking */
  sdkPrincipal: ISessionSdkPrincipal | null;
  /** Verified identity associated with this session */
  verifiedIdentity: ISessionVerifiedIdentity | null;
  /** Participants attached to this omnichannel session */
  attachedParticipants: ISessionAttachedParticipant[];
  /** Live sync state for omnichannel sessions */
  liveSyncState: ISessionLiveSyncState | null;
  source: SessionSource | null;
  /** Session purpose tag — orthogonal to `source` (front-door type).
   *  Defaults to null (treated as 'production' by billing/analytics). */
  knownSource: KnownSessionSource | null;
  projectSlug: string | null;
  region: string | null;
  callDuration: number | null;
  messageCount: number;
  tokenCount: number;
  estimatedCost: number;
  errorCount: number;
  handoffCount: number;
  traceEventCount: number;
  billingPeriod: string | null;
  isTest: boolean;
  tags: string[];
  /** ID of the A/B experiment this session is assigned to, if any. */
  experimentId: string | null;
  /** Group assignment for the experiment ('control' or 'experiment'). */
  experimentGroup: 'control' | 'experiment' | null;
  startedAt: Date;
  lastActivityAt: Date;
  endedAt: Date | null;
  archivedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const SessionSchema = new Schema<ISession>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    contactId: { type: String, default: null },
    callerNumber: { type: String, default: null },
    initiatedById: { type: String, default: null },
    customerId: { type: String, default: null },
    anonymousId: { type: String, default: null },
    currentAgent: { type: String, required: true },
    agentVersion: { type: String, default: null },
    environment: {
      type: String,
      required: true,
      enum: ['dev', 'staging', 'production'],
    },
    entryAgentName: { type: String, default: null },
    workflowId: { type: String, default: null },
    workflowStepId: { type: String, default: null },
    parentId: { type: String, default: null },
    channel: {
      type: String,
      required: true,
      enum: [
        'web',
        'web_chat',
        'web_debug',
        'voice',
        'sms',
        'whatsapp',
        'email',
        'api',
        'sdk',
        'http_async',
      ],
    },
    channelHistory: { type: [String], default: [] },
    status: {
      type: String,
      required: true,
      enum: ['active', 'idle', 'ended', 'completed', 'escalated', 'abandoned', 'archived'],
      default: 'active',
    },
    disposition: { type: String, default: null },
    dispositionCode: { type: String, default: null },
    outcome: {
      type: String,
      enum: [
        'contained',
        'contained_resolved',
        'contained_partial',
        'contained_unresolved',
        'escalated',
        'abandoned',
        null,
      ],
      default: null,
      index: true,
    },
    context: { type: Schema.Types.Mixed, default: {} },
    metadata: { type: Schema.Types.Mixed, default: {} },
    deploymentId: { type: String, default: null },
    channelArtifact: { type: String, default: null, maxlength: 64 },
    channelArtifactType: {
      type: String,
      default: null,
      enum: [
        null,
        'caller_id',
        'cookie',
        'device_id',
        'psid',
        'aad_id',
        'phone',
        'email_thread',
        'api_client',
        'sip_uri',
      ],
    },
    identityTier: { type: Number, default: 0, enum: [0, 1, 2] },
    verificationMethod: {
      type: String,
      default: null,
      enum: [
        null,
        'none',
        'cookie',
        'caller_id',
        'hmac',
        'otp',
        'oauth',
        'provider',
        'email_link',
        'webhook',
        'server_secret',
      ],
    },
    channelId: { type: String, default: null },
    sessionPrincipalId: { type: String, default: null },
    sdkPrincipal: {
      type: new Schema(
        {
          channelId: { type: String, required: true },
          permissions: { type: [String], default: [] },
          grantedCapabilities: { type: [String], default: [] },
        },
        { _id: false },
      ),
      default: null,
    },
    verifiedIdentity: {
      type: new Schema(
        {
          contactId: { type: String, required: true },
          method: { type: String, required: true },
          strength: { type: Number, required: true },
          verifiedAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    attachedParticipants: {
      type: [
        new Schema(
          {
            participantId: { type: String, required: true },
            channel: { type: String, required: true },
            mode: { type: String, required: true, enum: ['active', 'observe'] },
            interactive: { type: Boolean, default: true },
            attachedAt: { type: Date, required: true },
            detachedAt: { type: Date, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    liveSyncState: {
      type: new Schema(
        {
          status: { type: String, required: true, enum: ['inactive', 'active', 'ended'] },
          joinMode: { type: String, required: true, enum: ['prompt', 'auto_link'] },
          transcriptMode: { type: String, required: true, enum: ['final_only'] },
          lastSequence: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      default: null,
    },
    source: {
      type: new Schema(
        {
          type: { type: String, required: true, enum: ['studio', 'public', 'channel'] },
          workspaceUserId: { type: String, default: null },
          endUserId: { type: String, default: null },
          contactId: { type: String, default: null },
          channelId: { type: String, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
    knownSource: {
      type: String,
      default: null,
      enum: [null, 'production', 'eval', 'synthetic'],
      index: true,
    },
    projectSlug: { type: String, default: null },
    region: { type: String, default: null },
    callDuration: { type: Number, default: null },
    messageCount: { type: Number, default: 0 },
    tokenCount: { type: Number, default: 0 },
    estimatedCost: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },
    handoffCount: { type: Number, default: 0 },
    traceEventCount: { type: Number, default: 0 },
    billingPeriod: { type: String, default: null },
    isTest: { type: Boolean, default: false },
    tags: { type: [String], default: [] },
    experimentId: { type: String, default: null },
    experimentGroup: {
      type: String,
      enum: ['control', 'experiment', null],
      default: null,
    },
    startedAt: { type: Date, required: true },
    lastActivityAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'sessions' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

SessionSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

SessionSchema.index({ tenantId: 1, status: 1, lastActivityAt: -1 });
SessionSchema.index({ tenantId: 1, projectId: 1, status: 1, lastActivityAt: -1 }); // session list with project filter + sort
SessionSchema.index({ lastActivityAt: -1, status: 1 }); // cleanup/archival queries
SessionSchema.index({ tenantId: 1, contactId: 1 });
SessionSchema.index({ tenantId: 1, customerId: 1 }); // tenant-scoped customer lookup
SessionSchema.index({ tenantId: 1, anonymousId: 1 }); // tenant-scoped anonymous lookup
SessionSchema.index({ tenantId: 1, callerNumber: 1 });
SessionSchema.index({ tenantId: 1, workflowId: 1 });
SessionSchema.index({ tenantId: 1, projectId: 1, environment: 1 });
SessionSchema.index({ tenantId: 1, initiatedById: 1 });
SessionSchema.index({ tenantId: 1, billingPeriod: 1, isTest: 1 });
SessionSchema.index({ tenantId: 1, projectSlug: 1, status: 1 });
SessionSchema.index({ tenantId: 1, entryAgentName: 1, startedAt: -1 });
SessionSchema.index({ tenantId: 1, environment: 1, status: 1 });
SessionSchema.index({ deploymentId: 1, status: 1 });
SessionSchema.index({ customerId: 1 });
SessionSchema.index({ anonymousId: 1 });
SessionSchema.index({ parentId: 1 });
SessionSchema.index(
  { tenantId: 1, endedAt: 1 },
  { partialFilterExpression: { endedAt: { $type: 'date' } } },
);
SessionSchema.index(
  { tenantId: 1, projectId: 1, endedAt: 1 },
  { partialFilterExpression: { endedAt: { $type: 'date' } } },
);
SessionSchema.index(
  { tenantId: 1, channelId: 1, channelArtifact: 1, status: 1 },
  { partialFilterExpression: { channelArtifact: { $type: 'string' } } },
);
SessionSchema.index(
  { tenantId: 1, contactId: 1, startedAt: -1 },
  { partialFilterExpression: { contactId: { $type: 'string' } } },
);

// Omnichannel live session discovery: find active live sessions for a contact in a project
SessionSchema.index(
  { tenantId: 1, projectId: 1, 'liveSyncState.status': 1, contactId: 1 },
  { partialFilterExpression: { 'liveSyncState.status': { $exists: true } } },
);

// Session expiry is handled by the retention scheduler (retention-service.ts)
// which respects per-plan sessionRetentionDays (e.g. ENTERPRISE = 365 days).
// The TTL index below acts as a safety net if the scheduler fails. The 400-day
// expiry exceeds the maximum plan retention (365 days) so it never conflicts
// with configured retention, but ensures ended sessions are eventually cleaned up.
SessionSchema.index({ endedAt: 1 }, { expireAfterSeconds: 400 * 86400, sparse: true });

// Sparse index for experiment assignment lookups (most sessions have no experiment)
SessionSchema.index(
  { experimentId: 1 },
  { partialFilterExpression: { experimentId: { $type: 'string' } } },
);

// ─── Model ───────────────────────────────────────────────────────────────

export const Session =
  (mongoose.models.Session as any) || model<ISession>('Session', SessionSchema);
