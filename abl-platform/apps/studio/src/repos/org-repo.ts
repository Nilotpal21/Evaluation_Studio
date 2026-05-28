/**
 * Organization Repository
 *
 * MongoDB data access layer for Organization, OrgMember, DomainMapping, and SSOConfig entities.
 */

import { ensureDb } from '@/lib/ensure-db';

// ─── Type Helpers ────────────────────────────────────────────────────────

function normalizeId(doc: any): any {
  if (!doc) return doc;
  if (Array.isArray(doc)) return doc.map(normalizeId);
  if (doc._id) {
    const { _id, ...rest } = doc;
    return { id: _id, ...rest };
  }
  return doc;
}

// ═════════════════════════════════════════════════════════════════════════
// ORGANIZATION
// ═════════════════════════════════════════════════════════════════════════

// Organization is a top-level entity above tenants. Its _id IS the orgId.
// Callers reach it via tenant.organizationId (already scoped).
export async function findOrganizationById(id: string): Promise<any | null> {
  await ensureDb();
  const { Organization } = await import('@agent-platform/database/models');
  const doc = await Organization.findOne({ _id: id }).lean();
  return normalizeId(doc);
}

export async function findOrganizationBySlug(slug: string): Promise<any | null> {
  await ensureDb();
  const { Organization } = await import('@agent-platform/database/models');
  const doc = await Organization.findOne({ slug }).lean();
  return normalizeId(doc);
}

export async function createOrganization(data: {
  name: string;
  slug: string;
  ownerId: string;
  billingEmail?: string;
}): Promise<any> {
  await ensureDb();
  const { Organization } = await import('@agent-platform/database/models');
  const doc = await Organization.create({
    name: data.name,
    slug: data.slug,
    ownerId: data.ownerId,
    billingEmail: data.billingEmail || null,
    billingConfig: {},
    compliance: [],
    settings: {},
  });
  return normalizeId(doc.toObject());
}

export async function updateOrganization(
  id: string,
  data: {
    name?: string;
    billingEmail?: string;
    billingConfig?: any;
    compliance?: any[];
    settings?: any;
  },
): Promise<any> {
  await ensureDb();
  const { Organization } = await import('@agent-platform/database/models');
  // Use findOne + save() so the encryption plugin's pre-save hook fires
  // Organization is top-level; callers validate ownership before reaching here.
  const doc = await Organization.findOne({ _id: id });
  if (!doc) return null;
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) doc.set(key, value);
  }
  await doc.save();
  return normalizeId(doc.toObject());
}

export async function findOrganizations(where?: {
  ownerId?: string;
  slug?: string;
}): Promise<any[]> {
  await ensureDb();
  const { Organization } = await import('@agent-platform/database/models');
  const filter: any = {};
  if (where?.ownerId) filter.ownerId = where.ownerId;
  if (where?.slug) filter.slug = where.slug;
  const docs = await Organization.find(filter).lean();
  return normalizeId(docs);
}

// ═════════════════════════════════════════════════════════════════════════
// ORG MEMBER
// ═════════════════════════════════════════════════════════════════════════

export async function createOrgMember(data: {
  organizationId: string;
  userId: string;
  role: string;
}): Promise<any> {
  await ensureDb();
  const { OrgMember } = await import('@agent-platform/database/models');
  const doc = await OrgMember.create(data);
  return normalizeId(doc.toObject());
}

export async function findOrgMember(organizationId: string, userId: string): Promise<any | null> {
  await ensureDb();
  const { OrgMember } = await import('@agent-platform/database/models');
  const doc = await OrgMember.findOne({ organizationId, userId }).lean();
  return normalizeId(doc);
}

export async function findOrgMembers(organizationId: string): Promise<any[]> {
  await ensureDb();
  const { OrgMember } = await import('@agent-platform/database/models');
  const docs = await OrgMember.find({ organizationId }).lean();
  return normalizeId(docs);
}

export async function updateOrgMember(
  organizationId: string,
  userId: string,
  data: { role?: string },
): Promise<any> {
  await ensureDb();
  const { OrgMember } = await import('@agent-platform/database/models');
  const doc = await OrgMember.findOneAndUpdate(
    { organizationId, userId },
    { $set: data },
    { new: true },
  ).lean();
  return normalizeId(doc);
}

export async function deleteOrgMember(organizationId: string, userId: string): Promise<void> {
  await ensureDb();
  const { OrgMember } = await import('@agent-platform/database/models');
  await OrgMember.deleteOne({ organizationId, userId });
}

// ═════════════════════════════════════════════════════════════════════════
// DOMAIN MAPPING
// ═════════════════════════════════════════════════════════════════════════

export async function findDomainMapping(domain: string): Promise<any | null> {
  await ensureDb();
  const normalizedDomain = domain.toLowerCase();

  const { Organization } = await import('@agent-platform/database/models');
  const org = await Organization.findOne({
    'domainMappings.domain': normalizedDomain,
  }).lean();

  if (!org) return null;

  const mapping = org.domainMappings?.find((d: any) => d.domain === normalizedDomain);
  if (!mapping) return null;

  return {
    id: mapping.id,
    organizationId: org._id,
    domain: mapping.domain,
    verified: mapping.verified,
    verificationToken: mapping.verificationToken,
    verifiedAt: mapping.verifiedAt,
    createdAt: mapping.createdAt,
  };
}

export async function upsertDomainMapping(
  domain: string,
  data: {
    organizationId: string;
    verificationToken?: string;
    verified?: boolean;
    verifiedAt?: Date | null;
  },
): Promise<any> {
  await ensureDb();
  const normalizedDomain = domain.toLowerCase();

  const { Organization } = await import('@agent-platform/database/models');
  const { uuidv7 } = await import('@agent-platform/database/mongo');

  const existing = await Organization.findOne({
    'domainMappings.domain': normalizedDomain,
  });

  const now = new Date();
  const mappingId = uuidv7();

  if (existing) {
    // Update existing mapping
    const updateFields: any = {};
    if (data.verificationToken !== undefined) {
      updateFields['domainMappings.$.verificationToken'] = data.verificationToken;
    }
    if (data.verified !== undefined) {
      updateFields['domainMappings.$.verified'] = data.verified;
    }
    if (data.verifiedAt !== undefined) {
      updateFields['domainMappings.$.verifiedAt'] = data.verifiedAt;
    }

    await Organization.updateOne(
      { 'domainMappings.domain': normalizedDomain },
      { $set: updateFields },
    );

    const updated = await Organization.findOne({
      'domainMappings.domain': normalizedDomain,
    }).lean();

    const mapping = updated?.domainMappings?.find((d: any) => d.domain === normalizedDomain);
    return mapping
      ? {
          id: mapping.id,
          organizationId: updated!._id,
          domain: mapping.domain,
          verified: mapping.verified,
          verificationToken: mapping.verificationToken,
          verifiedAt: mapping.verifiedAt,
          createdAt: mapping.createdAt,
        }
      : null;
  } else {
    // Create new mapping
    await Organization.updateOne(
      { _id: data.organizationId },
      {
        $push: {
          domainMappings: {
            id: mappingId,
            domain: normalizedDomain,
            verified: data.verified || false,
            verificationToken: data.verificationToken || '',
            verifiedAt: data.verifiedAt || null,
            createdAt: now,
          },
        },
      },
    );

    return {
      id: mappingId,
      organizationId: data.organizationId,
      domain: normalizedDomain,
      verified: data.verified || false,
      verificationToken: data.verificationToken || '',
      verifiedAt: data.verifiedAt || null,
      createdAt: now,
    };
  }
}

export async function updateDomainMapping(
  domain: string,
  data: {
    verified?: boolean;
    verifiedAt?: Date | null;
  },
): Promise<any> {
  await ensureDb();
  const normalizedDomain = domain.toLowerCase();

  const { Organization } = await import('@agent-platform/database/models');

  const updateFields: any = {};
  if (data.verified !== undefined) {
    updateFields['domainMappings.$.verified'] = data.verified;
  }
  if (data.verifiedAt !== undefined) {
    updateFields['domainMappings.$.verifiedAt'] = data.verifiedAt;
  }

  await Organization.updateOne(
    { 'domainMappings.domain': normalizedDomain },
    { $set: updateFields },
  );

  const updated = await Organization.findOne({
    'domainMappings.domain': normalizedDomain,
  }).lean();

  const mapping = updated?.domainMappings?.find((d: any) => d.domain === normalizedDomain);
  return mapping
    ? {
        id: mapping.id,
        organizationId: updated!._id,
        domain: mapping.domain,
        verified: mapping.verified,
        verificationToken: mapping.verificationToken,
        verifiedAt: mapping.verifiedAt,
        createdAt: mapping.createdAt,
      }
    : null;
}

export async function deleteDomainMapping(domain: string): Promise<void> {
  await ensureDb();
  const normalizedDomain = domain.toLowerCase();

  const { Organization } = await import('@agent-platform/database/models');
  await Organization.updateOne(
    { 'domainMappings.domain': normalizedDomain },
    { $pull: { domainMappings: { domain: normalizedDomain } } },
  );
}

export async function findDomainMappings(organizationId: string): Promise<any[]> {
  await ensureDb();
  const { Organization } = await import('@agent-platform/database/models');
  const org = await Organization.findOne({ _id: organizationId }).lean();
  if (!org || !org.domainMappings) return [];

  return org.domainMappings.map((m: any) => ({
    id: m.id,
    organizationId: org._id,
    domain: m.domain,
    verified: m.verified,
    verificationToken: m.verificationToken,
    verifiedAt: m.verifiedAt,
    createdAt: m.createdAt,
  }));
}

// ═════════════════════════════════════════════════════════════════════════
// SSO CONFIG
// ═════════════════════════════════════════════════════════════════════════

/**
 * Find an organization by matching a SAML IdP entity ID stored in its ssoConfigs.
 * Used for IdP-initiated SAML flows where RelayState is absent.
 */
export async function findOrgBySAMLIssuer(issuer: string): Promise<{ id: string } | null> {
  await ensureDb();
  const { Organization } = await import('@agent-platform/database/models');

  // Search for orgs with an active SAML config whose idpEntityId matches the issuer
  const org = await Organization.findOne({
    ssoConfigs: {
      $elemMatch: {
        protocol: 'saml',
        isActive: true,
        idpEntityId: issuer,
      },
    },
  }).lean();

  if (!org) return null;
  return { id: String(org._id) };
}

export async function findSSOConfig(organizationId: string): Promise<any | null> {
  await ensureDb();
  const { Organization } = await import('@agent-platform/database/models');
  const org = await Organization.findOne({ _id: organizationId }).lean();
  if (!org || !org.ssoConfigs || org.ssoConfigs.length === 0) return null;

  // Return the first active SSO config
  const config = org.ssoConfigs.find((c: any) => c.isActive) || org.ssoConfigs[0];
  return {
    id: config.id,
    organizationId: org._id,
    protocol: config.protocol,
    encryptedConfig: config.encryptedConfig,
    forceSso: config.forceSso,
    allowGoogleFallback: config.allowGoogleFallback,
    isActive: config.isActive,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

export async function createSSOConfig(data: {
  organizationId: string;
  protocol: string;
  encryptedConfig: string;
  forceSso?: boolean;
  allowGoogleFallback?: boolean;
  isActive?: boolean;
}): Promise<any> {
  await ensureDb();
  const { Organization } = await import('@agent-platform/database/models');
  const { uuidv7 } = await import('@agent-platform/database/mongo');

  const now = new Date();
  const configId = uuidv7();

  await Organization.updateOne(
    { _id: data.organizationId },
    {
      $push: {
        ssoConfigs: {
          id: configId,
          protocol: data.protocol,
          encryptedConfig: data.encryptedConfig,
          forceSso: data.forceSso || false,
          allowGoogleFallback:
            data.allowGoogleFallback !== undefined ? data.allowGoogleFallback : true,
          isActive: data.isActive !== undefined ? data.isActive : true,
          createdAt: now,
          updatedAt: now,
        },
      },
    },
  );

  return {
    id: configId,
    organizationId: data.organizationId,
    protocol: data.protocol,
    encryptedConfig: data.encryptedConfig,
    forceSso: data.forceSso || false,
    allowGoogleFallback: data.allowGoogleFallback !== undefined ? data.allowGoogleFallback : true,
    isActive: data.isActive !== undefined ? data.isActive : true,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateSSOConfig(
  id: string,
  data: {
    encryptedConfig?: string;
    forceSso?: boolean;
    allowGoogleFallback?: boolean;
    isActive?: boolean;
  },
): Promise<any> {
  await ensureDb();
  const { Organization } = await import('@agent-platform/database/models');

  const updateFields: any = { 'ssoConfigs.$.updatedAt': new Date() };
  if (data.encryptedConfig !== undefined) {
    updateFields['ssoConfigs.$.encryptedConfig'] = data.encryptedConfig;
  }
  if (data.forceSso !== undefined) {
    updateFields['ssoConfigs.$.forceSso'] = data.forceSso;
  }
  if (data.allowGoogleFallback !== undefined) {
    updateFields['ssoConfigs.$.allowGoogleFallback'] = data.allowGoogleFallback;
  }
  if (data.isActive !== undefined) {
    updateFields['ssoConfigs.$.isActive'] = data.isActive;
  }

  await Organization.updateOne({ 'ssoConfigs.id': id }, { $set: updateFields });

  const updated = await Organization.findOne({ 'ssoConfigs.id': id }).lean();
  const config = updated?.ssoConfigs?.find((c: any) => c.id === id);

  return config
    ? {
        id: config.id,
        organizationId: updated!._id,
        protocol: config.protocol,
        encryptedConfig: config.encryptedConfig,
        forceSso: config.forceSso,
        allowGoogleFallback: config.allowGoogleFallback,
        isActive: config.isActive,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
      }
    : null;
}

export async function deleteSSOConfig(id: string): Promise<void> {
  await ensureDb();
  const { Organization } = await import('@agent-platform/database/models');
  await Organization.updateOne({ 'ssoConfigs.id': id }, { $pull: { ssoConfigs: { id } } });
}
