/**
 * ACL Document Permissions Model
 *
 * Stores per-document permission data for OpenSearch indexing.
 * Replaces Neo4j Document nodes + HAS_PERMISSION edges.
 *
 * Each document has:
 * - allowedUsers: specific users with direct access
 * - allowedGroups: groups whose members have access
 * - allowedDomains: entire domains with access
 * - publicInDomain: accessible to all users in the organization
 * - publicEverywhere: accessible to everyone (anonymous links)
 *
 * The embedding worker reads this collection to stamp permissions
 * on every OpenSearch chunk. This is the source of truth for
 * document-level permissions.
 */

import mongoose, { Schema, model } from 'mongoose';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Subdocument Interfaces ─────────────────────────────────────────────

export interface IAllowedUser {
  email: string;
  role: 'read' | 'write' | 'owner';
  grantedAt: Date;
}

export interface IAllowedGroup {
  groupId: string;
  role: 'read' | 'write' | 'owner';
  grantedAt: Date;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IAclDocumentPermissions {
  _id: string;
  tenantId: string;
  /** The SearchDocument._id this permission record maps to */
  documentId: string;
  /** Connector source that crawled these permissions */
  source: string;
  /** Users with direct access to this document */
  allowedUsers: IAllowedUser[];
  /** Groups whose members have access */
  allowedGroups: IAllowedGroup[];
  /** Domains with organization-wide access */
  allowedDomains: string[];
  /** Accessible to all users within the Azure AD tenant (org-wide sharing link) */
  publicInDomain: boolean;
  /** Accessible to everyone (anonymous sharing link) */
  publicEverywhere: boolean;
  /** When permissions were last crawled from the source */
  lastPermissionCrawlAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Subdocument Schemas ────────────────────────────────────────────────

const AllowedUserSchema = new Schema<IAllowedUser>(
  {
    email: { type: String, required: true },
    role: { type: String, required: true, enum: ['read', 'write', 'owner'] },
    grantedAt: { type: Date, required: true },
  },
  { _id: false },
);

const AllowedGroupSchema = new Schema<IAllowedGroup>(
  {
    groupId: { type: String, required: true },
    role: { type: String, required: true, enum: ['read', 'write', 'owner'] },
    grantedAt: { type: Date, required: true },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const AclDocumentPermissionsSchema = new Schema<IAclDocumentPermissions>(
  {
    tenantId: { type: String, required: true },
    documentId: { type: String, required: true },
    source: { type: String, required: true },
    allowedUsers: { type: [AllowedUserSchema], default: [] },
    allowedGroups: { type: [AllowedGroupSchema], default: [] },
    allowedDomains: { type: [String], default: [] },
    publicInDomain: { type: Boolean, default: false },
    publicEverywhere: { type: Boolean, default: false },
    lastPermissionCrawlAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'acl_document_permissions' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

AclDocumentPermissionsSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Primary lookup: find permissions by tenant + documentId (unique per tenant)
AclDocumentPermissionsSchema.index({ tenantId: 1, documentId: 1 }, { unique: true });

// Find all documents by source (for connector-specific recrawl)
AclDocumentPermissionsSchema.index({ tenantId: 1, source: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const AclDocumentPermissions =
  (mongoose.models.AclDocumentPermissions as any) ||
  model<IAclDocumentPermissions>('AclDocumentPermissions', AclDocumentPermissionsSchema);
