/**
 * ACL Group Hierarchy Model
 *
 * Stores group tree structure for BFS pre-computation of effective groups.
 * Replaces Neo4j Group nodes and MEMBER_OF edges.
 *
 * Each document represents one group with its parent-child relationships
 * and direct member emails. The full hierarchy is loaded into memory at
 * BFS computation time (~2MB for 5K groups).
 *
 * Sources: Azure AD, Okta, Google, SharePoint site groups.
 */

import mongoose, { Schema, model } from 'mongoose';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IAclGroupHierarchy {
  _id: string;
  tenantId: string;
  /** Namespaced group ID, e.g. "azuread:{guid}" or "sharepoint:{id}" */
  groupId: string;
  /** IdP / connector that owns this group */
  source: string;
  /** Human-readable group name */
  displayName: string | null;
  /** Group email (if available from IdP) */
  email: string | null;
  /** Parent group IDs (for upward BFS traversal) */
  parentGroups: string[];
  /** Child group IDs (for downward hierarchy UI queries) */
  childGroups: string[];
  /** Direct member emails (for mapping users → groups) */
  directMemberEmails: string[];
  lastSyncAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const AclGroupHierarchySchema = new Schema<IAclGroupHierarchy>(
  {
    tenantId: { type: String, required: true },
    groupId: { type: String, required: true },
    source: { type: String, required: true },
    displayName: { type: String, default: null },
    email: { type: String, default: null },
    parentGroups: { type: [String], default: [] },
    childGroups: { type: [String], default: [] },
    directMemberEmails: { type: [String], default: [] },
    lastSyncAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'acl_group_hierarchy' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

AclGroupHierarchySchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Primary lookup: find group by tenant + groupId (unique per tenant)
AclGroupHierarchySchema.index({ tenantId: 1, groupId: 1 }, { unique: true });

// Find all groups for a tenant by source (for sync reconciliation)
AclGroupHierarchySchema.index({ tenantId: 1, source: 1 });

// Find groups that contain a specific member email (for user → groups mapping)
AclGroupHierarchySchema.index({ tenantId: 1, directMemberEmails: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const AclGroupHierarchy =
  (mongoose.models.AclGroupHierarchy as any) ||
  model<IAclGroupHierarchy>('AclGroupHierarchy', AclGroupHierarchySchema);
