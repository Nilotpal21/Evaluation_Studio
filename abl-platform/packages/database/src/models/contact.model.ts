/**
 * Contact Model
 *
 * Stores contacts (employees, customers, anonymous users) in the ABL Platform.
 * Each contact is scoped to a tenant and tracks identity and activity.
 *
 * Identities are stored as encrypted subdocuments with blind indexes for
 * searching without decryption (AES-256-GCM + HMAC-SHA256).
 *
 * Backward compatibility: the flat `identity`/`identityType` fields are
 * retained for existing data. New code should use the `identities` array.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Subdocument Interfaces ─────────────────────────────────────────────

export interface IContactIdentity {
  type: string;
  encryptedValue: string;
  blindIndex: string;
  verified: boolean;
  verifiedAt: Date | null;
  verifiedVia: string | null;
  channel: string | null;
}

export interface IChannelHistoryEntry {
  channelType: string;
  channelId: string;
  firstSessionAt: Date;
  lastSessionAt: Date;
  sessionCount: number;
}

export interface ISourceIdentity {
  /** IdP / connector name (e.g. "azuread", "sharepoint", "jira") */
  source: string;
  /** User ID in the source system (not PII — opaque ID) */
  sourceUserId: string;
  /** Encrypted email as known by this source (GDPR compliant) */
  encryptedEmail: string | null;
  /** HMAC blind index for email lookup without decryption */
  blindIndex: string | null;
  /** Encrypted display name from source */
  displayName: string | null;
  /** Whether this source identity has been resolved/linked */
  resolved: boolean;
  /** When this source last synced */
  lastSyncAt: Date;
}

export interface IAclDirectGroup {
  /** Namespaced group ID, e.g. "azuread:{guid}" or "sharepoint:{id}" */
  group: string;
  /** Which connector/IdP granted this group */
  source: string;
  /** When this group membership was added */
  addedAt: Date;
}

export interface IContactAcl {
  /** BFS pre-computed transitive group closure (flat array for query-time) */
  effectiveGroups: string[];
  /** Direct group memberships with source attribution (for delta recomputation + un-merge) */
  directGroups: IAclDirectGroup[];
  /** Email domain extracted from primary email identity */
  domain: string | null;
  /** When effectiveGroups was last BFS-computed */
  effectiveGroupsComputedAt: Date | null;
  /** Monotonic version for sync conflict detection */
  syncVersion: number;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IContact {
  _id: string;
  tenantId: string;
  type: string;

  // ── Encrypted identities array ─────────────────────────────────────
  identities: IContactIdentity[];
  channelHistory: IChannelHistoryEntry[];
  sessionCount: number;
  mergedInto: string | null;

  // ── Source identities (from SearchAI connector sync) ───────────────
  sourceIdentities: ISourceIdentity[];

  // ── ACL data (replaces Neo4j user groups) ──────────────────────────
  acl: IContactAcl | null;

  // ── Legacy flat fields (backward compat) ───────────────────────────
  identity: string | null;
  identityType: string | null;

  displayName: string | null;
  department: string | null;
  employeeId: string | null;
  company: string | null;
  accountRef: string | null;
  channel: string | null;
  metadata: any;
  tags: string[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  deletedAt: Date | null;
  encryptionSalt: string | null;
  contactContext: {
    preferences: Record<string, unknown>;
    dataValues: Record<string, unknown>;
    lastDisposition: string | null;
    lastInteraction: Date | null;
    sessionCount: number;
    updatedAt: Date;
  } | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Subdocument Schemas ────────────────────────────────────────────────

const ContactIdentitySchema = new Schema<IContactIdentity>(
  {
    type: {
      type: String,
      required: true,
      enum: ['email', 'phone', 'external'],
    },
    encryptedValue: { type: String, required: true },
    blindIndex: { type: String, required: true },
    verified: { type: Boolean, default: false },
    verifiedAt: { type: Date, default: null },
    verifiedVia: {
      type: String,
      default: null,
      enum: [
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
        null,
      ],
    },
    channel: { type: String, default: null },
  },
  { _id: false },
);

const SourceIdentitySchema = new Schema<ISourceIdentity>(
  {
    source: { type: String, required: true },
    sourceUserId: { type: String, required: true },
    encryptedEmail: { type: String, default: null },
    blindIndex: { type: String, default: null },
    displayName: { type: String, default: null },
    resolved: { type: Boolean, default: false },
    lastSyncAt: { type: Date, required: true },
  },
  { _id: false },
);

const AclDirectGroupSchema = new Schema<IAclDirectGroup>(
  {
    group: { type: String, required: true },
    source: { type: String, required: true },
    addedAt: { type: Date, required: true },
  },
  { _id: false },
);

const ContactAclSchema = new Schema<IContactAcl>(
  {
    effectiveGroups: { type: [String], default: [] },
    directGroups: { type: [AclDirectGroupSchema], default: [] },
    domain: { type: String, default: null },
    effectiveGroupsComputedAt: { type: Date, default: null },
    syncVersion: { type: Number, default: 0 },
  },
  { _id: false },
);

const ChannelHistoryEntrySchema = new Schema<IChannelHistoryEntry>(
  {
    channelType: { type: String, required: true },
    channelId: { type: String, required: true },
    firstSessionAt: { type: Date, required: true },
    lastSessionAt: { type: Date, required: true },
    sessionCount: { type: Number, default: 0 },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const ContactSchema = new Schema<IContact>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['employee', 'customer', 'anonymous'],
    },

    // ── Encrypted identities array ─────────────────────────────────
    identities: { type: [ContactIdentitySchema], default: [] },
    channelHistory: { type: [ChannelHistoryEntrySchema], default: [] },
    sessionCount: { type: Number, default: 0 },
    mergedInto: { type: String, default: null },

    // ── Source identities (from SearchAI connector sync) ─────────
    sourceIdentities: { type: [SourceIdentitySchema], default: [] },

    // ── ACL data (replaces Neo4j user groups) ────────────────────
    acl: { type: ContactAclSchema, default: null },

    // ── Legacy flat fields (backward compat) ───────────────────────
    identity: { type: String, default: null },
    identityType: {
      type: String,
      default: null,
      enum: ['email', 'phone', 'external', null],
    },

    displayName: { type: String, default: null },
    department: { type: String, default: null },
    employeeId: { type: String, default: null },
    company: { type: String, default: null },
    accountRef: { type: String, default: null },
    channel: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
    tags: { type: [String], default: [] },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    deletedAt: { type: Date, default: null },
    encryptionSalt: { type: String, default: null },
    contactContext: {
      type: Schema.Types.Mixed,
      default: null,
      validate: {
        validator(v: unknown) {
          if (v === null || v === undefined) return true;
          // Guard against unbounded growth: 64 KB serialized limit
          return JSON.stringify(v).length <= 65_536;
        },
        message: 'contactContext exceeds maximum allowed size (64 KB)',
      },
    },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'contacts' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ContactSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Existing indexes (backward compat)
ContactSchema.index({ tenantId: 1, identityType: 1, identity: 1 });
ContactSchema.index({ tenantId: 1, type: 1 });
ContactSchema.index({ tenantId: 1, lastSeenAt: -1 });
ContactSchema.index({ tenantId: 1, deletedAt: 1 });

// New indexes for encrypted identity lookups
ContactSchema.index({ tenantId: 1, 'identities.blindIndex': 1 });
ContactSchema.index({ tenantId: 1, mergedInto: 1 });

// Source identity indexes (for SearchAI connector sync lookups)
ContactSchema.index({
  tenantId: 1,
  'sourceIdentities.source': 1,
  'sourceIdentities.sourceUserId': 1,
});
ContactSchema.index({ tenantId: 1, 'sourceIdentities.blindIndex': 1 });

// ACL indexes (for permission query resolution)
ContactSchema.index({ tenantId: 1, 'acl.domain': 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const Contact =
  (mongoose.models.Contact as any) || model<IContact>('Contact', ContactSchema);
