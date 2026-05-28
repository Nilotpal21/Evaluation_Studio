/**
 * Organization Model
 *
 * Top-level entity that groups tenants, users, and billing.
 * Supports SSO configurations and domain-based auto-assignment.
 * Billing config is field-level encrypted at rest.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';

// ─── Embedded Subdocument Interfaces ─────────────────────────────────────

interface ISsoConfig {
  id: string;
  protocol: string;
  encryptedConfig: string;
  forceSso: boolean;
  allowGoogleFallback: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface IDomainMapping {
  id: string;
  domain: string;
  verified: boolean;
  verificationToken: string;
  verifiedAt: Date | null;
  createdAt: Date;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IOrganization {
  _id: string;
  name: string;
  slug: string;
  ownerId: string;
  billingEmail: string | null;
  billingConfig: any;
  compliance: any[];
  settings: any;
  ssoConfigs: ISsoConfig[];
  domainMappings: IDomainMapping[];
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Embedded Schemas ────────────────────────────────────────────────────

const SsoConfigSchema = new Schema<ISsoConfig>(
  {
    id: { type: String, required: true },
    protocol: { type: String, required: true, enum: ['saml', 'oidc'] },
    encryptedConfig: { type: String, required: true },
    forceSso: { type: Boolean, default: false },
    allowGoogleFallback: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  { _id: false },
);

const DomainMappingSchema = new Schema<IDomainMapping>(
  {
    id: { type: String, required: true },
    domain: { type: String, required: true },
    verified: { type: Boolean, default: false },
    verificationToken: { type: String, required: true },
    verifiedAt: { type: Date, default: null },
    createdAt: { type: Date, required: true },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const OrganizationSchema = new Schema<IOrganization>(
  {
    _id: { type: String, default: uuidv7 },
    name: { type: String, required: true },
    slug: { type: String, required: true },
    ownerId: { type: String, required: true },
    billingEmail: { type: String, default: null },
    billingConfig: { type: Schema.Types.Mixed, default: null },
    compliance: [{ type: Schema.Types.Mixed }],
    settings: { type: Schema.Types.Mixed, default: null },
    ssoConfigs: { type: [SsoConfigSchema], default: [] },
    domainMappings: { type: [DomainMappingSchema], default: [] },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'organizations' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

// TENANT_PLUGIN_EXCEPTION: Organization has no tenantId field — the
// `tenantIdField: '_id'` below is an encryption plugin option, not a schema field.
OrganizationSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['billingConfig'],
  tenantIdField: '_id',
  scope: 'tenant',
  scopeFields: { tenantId: '_id' },
});
OrganizationSchema.plugin(auditTrailPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

OrganizationSchema.index({ slug: 1 }, { unique: true });
OrganizationSchema.index({ ownerId: 1 });
OrganizationSchema.index({ 'domainMappings.domain': 1 }, { unique: true, sparse: true });

// ─── Model ───────────────────────────────────────────────────────────────

export const Organization =
  (mongoose.models.Organization as any) || model<IOrganization>('Organization', OrganizationSchema);
