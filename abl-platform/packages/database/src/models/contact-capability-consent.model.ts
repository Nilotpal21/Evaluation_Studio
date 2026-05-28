/**
 * Contact Capability Consent Model
 *
 * Tracks per-contact, per-project consent for omnichannel capabilities
 * (e.g., cross-channel recall, live transcript sync). Project-scoped
 * with independent audit lifecycle from the contact model.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IContactCapabilityConsent {
  _id: string;
  tenantId: string;
  projectId: string;
  contactId: string;
  capability: 'cross_channel_recall' | 'live_transcript_sync';
  state: 'granted' | 'revoked';
  grantedBy: string;
  grantedAt: Date;
  revokedAt: Date | null;
  policyVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ContactCapabilityConsentSchema = new Schema<IContactCapabilityConsent>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    contactId: { type: String, required: true },
    capability: {
      type: String,
      required: true,
      enum: ['cross_channel_recall', 'live_transcript_sync'],
    },
    state: {
      type: String,
      required: true,
      enum: ['granted', 'revoked'],
      default: 'granted',
    },
    grantedBy: { type: String, required: true },
    grantedAt: { type: Date, required: true, default: () => new Date() },
    revokedAt: { type: Date, default: null },
    policyVersion: { type: String, required: true, default: '1.0' },
  },
  { timestamps: true, collection: 'contact_capability_consents' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ContactCapabilityConsentSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Unique compound: one consent record per contact+project+capability
ContactCapabilityConsentSchema.index(
  { tenantId: 1, projectId: 1, contactId: 1, capability: 1 },
  { unique: true },
);

// Query pattern: check all consents for a contact in a project
ContactCapabilityConsentSchema.index({ tenantId: 1, projectId: 1, contactId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const ContactCapabilityConsent =
  (mongoose.models.ContactCapabilityConsent as mongoose.Model<IContactCapabilityConsent>) ||
  model<IContactCapabilityConsent>('ContactCapabilityConsent', ContactCapabilityConsentSchema);
