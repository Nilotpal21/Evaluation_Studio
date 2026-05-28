import { z } from 'zod';

const VALID_PLAN_TIERS = ['FREE', 'TEAM', 'BUSINESS', 'ENTERPRISE'] as const;
const VALID_MEMBER_ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;
const VALID_TENANT_STATUSES = ['active', 'suspended', 'archived'] as const;
const VALID_FEATURE_CAPABILITIES = [
  'text',
  'tools',
  'streaming',
  'vision',
  'realtime_voice',
] as const;
const VALID_DEAL_STATUSES = ['active', 'paused', 'expired', 'canceled'] as const;
const VALID_DEAL_SCOPES = ['organization', 'project'] as const;
const VALID_AGGREGATION_MODES = ['additive', 'max_wins', 'dedicated'] as const;
const VALID_OVERAGE_POLICIES = ['hard_stop', 'soft_cap', 'auto_upgrade'] as const;
const VALID_ROLLOVER_POLICIES = ['none', 'partial', 'full'] as const;
const VALID_LINE_ITEM_CATEGORIES = ['base', 'overage', 'addon', 'credit_topup'] as const;
const VALID_ATTACHMENT_RETENTION_KINDS = ['image', 'document', 'audio', 'video'] as const;
const VALID_LIMIT_KEYS = [
  'maxConcurrentSessions',
  'maxServiceTimeoutMs',
  'maxResponseBodyBytes',
  'maxConcurrentServiceCalls',
  'maxPendingTimers',
  'maxAgentsPerProject',
  'maxEventTypesPerApp',
  'maxProjectsPerOrg',
  'requestsPerMinute',
  'tokensPerMinute',
  'toolCallsPerMinute',
  'messagesPerMonth',
  'traceRetentionDays',
  'sessionRetentionDays',
  'auditLogRetentionDays',
  'messageRetentionDays',
] as const;

const MAX_FIELD_LENGTH = 256;
const MAX_NOTE_LENGTH = 1024;
const MIN_MAX_FILE_SIZE_BYTES = 1024;
const MAX_MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024;
const MAX_MIME_TYPE_LIST_LENGTH = 200;
const MAX_ATTACHMENTS_PER_SESSION_CEILING = 10_000;
const MAX_TOTAL_STORAGE_BYTES_CEILING = 1024 * 1024 * 1024 * 1024;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 365;

export const hubSpotSyncRequestSchema = z
  .object({
    hubspotDealId: z.string().min(1),
  })
  .strict();

export const createTenantSchema = z
  .object({
    name: z.string().min(1).max(100),
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    planTier: z.enum(VALID_PLAN_TIERS).optional(),
  })
  .strict();

export const tenantStatusChangeSchema = z
  .object({
    status: z.enum(VALID_TENANT_STATUSES),
  })
  .strict();

export const tenantFeatureFlagSchema = z
  .object({
    codeToolsEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.codeToolsEnabled !== undefined, {
    message: 'No feature flags provided',
  });

export const tenantFeatureOverrideSchema = z
  .object({
    featureId: z.string().min(1),
    enabled: z.boolean(),
  })
  .strict();

export const tenantSubscriptionChangeSchema = z
  .object({
    planTier: z.enum(VALID_PLAN_TIERS),
  })
  .strict();

export const addTenantMemberSchema = z
  .object({
    email: z.string().email(),
    role: z.enum(VALID_MEMBER_ROLES),
  })
  .strict();

export const updateTenantMemberRoleSchema = z
  .object({
    role: z.enum(VALID_MEMBER_ROLES),
  })
  .strict();

export const createTenantProjectSchema = z
  .object({
    name: z.string().min(1).max(200),
    slug: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  })
  .strict();

export const deleteTenantProjectSchema = z
  .object({
    projectId: z.string().min(1),
  })
  .strict();

const limitSetSchema = z
  .object({
    maxConcurrentSessions: z.number().nonnegative(),
    maxTokensPerMinute: z.number().nonnegative(),
    maxRequestsPerMinute: z.number().nonnegative(),
    maxStorageGB: z.number().nonnegative(),
  })
  .strict();

const dealPhaseSchema = z
  .object({
    name: z.string().min(1),
    startDate: z.union([z.string(), z.date()]),
    endDate: z.union([z.string(), z.date()]),
    environments: z
      .object({
        dev: limitSetSchema,
        staging: limitSetSchema,
        production: limitSetSchema,
      })
      .strict(),
  })
  .strict();

const creditAllotmentSchema = z
  .object({
    totalCredits: z.number().nonnegative(),
    sharedPoolCredits: z.number().nonnegative(),
    featureCredits: z.record(z.number().nonnegative()).default({}),
    rolloverPolicy: z.enum(VALID_ROLLOVER_POLICIES),
    rolloverPercentage: z.number().min(0).max(100).optional(),
  })
  .strict();

export const createDealSchema = z
  .object({
    organizationId: z.string().min(1),
    hubspotDealId: z.string().optional(),
    name: z.string().min(1),
    status: z.enum(VALID_DEAL_STATUSES),
    scope: z.enum(VALID_DEAL_SCOPES),
    projectId: z.string().optional(),
    aggregationMode: z.enum(VALID_AGGREGATION_MODES),
    phases: z.array(dealPhaseSchema).max(50).optional(),
    overagePolicy: z.enum(VALID_OVERAGE_POLICIES),
    overageAlertThresholds: z.array(z.number()).max(20).optional(),
    creditAllotment: creditAllotmentSchema.optional(),
    features: z.array(z.string()).max(100).optional(),
    renewalDate: z.string().optional(),
    contractEndDate: z.string().optional(),
  })
  .strict();

export const updateDealSchema = z
  .object({
    name: z.string().min(1).optional(),
    hubspotDealId: z.string().nullable().optional(),
    status: z.enum(VALID_DEAL_STATUSES).optional(),
    scope: z.enum(VALID_DEAL_SCOPES).optional(),
    projectId: z.string().nullable().optional(),
    aggregationMode: z.enum(VALID_AGGREGATION_MODES).optional(),
    phases: z.array(dealPhaseSchema).max(50).optional(),
    overagePolicy: z.enum(VALID_OVERAGE_POLICIES).optional(),
    overageAlertThresholds: z.array(z.number()).max(20).optional(),
    creditAllotment: creditAllotmentSchema.optional(),
    features: z.array(z.string()).max(100).optional(),
    renewalDate: z.string().nullable().optional(),
    contractEndDate: z.string().nullable().optional(),
  })
  .strict();

export const creditTopupSchema = z
  .object({
    feature: z.string().min(1).optional(),
    credits: z.number().positive().max(10_000_000),
    description: z.string().optional(),
  })
  .strict();

export const createDealLineItemSchema = z
  .object({
    periodLabel: z.string().min(1),
    description: z.string().min(1),
    quantity: z.number(),
    unitPrice: z.number(),
    totalAmount: z.number(),
    category: z.enum(VALID_LINE_ITEM_CATEGORIES),
    invoiced: z.boolean().optional(),
    invoiceId: z.string().optional(),
  })
  .strict();

export const updateDealLineItemSchema = z
  .object({
    description: z.string().min(1).optional(),
    quantity: z.number().optional(),
    unitPrice: z.number().optional(),
    totalAmount: z.number().optional(),
    category: z.enum(VALID_LINE_ITEM_CATEGORIES).optional(),
    invoiced: z.boolean().optional(),
    invoiceId: z.string().nullable().optional(),
  })
  .strict();

export const tenantModelProvisionSchema = z
  .object({
    targetTenantId: z.string().min(1),
    displayName: z.string().min(1).max(MAX_FIELD_LENGTH),
    integrationType: z.enum(['easy', 'api']).optional(),
    modelId: z.string().optional(),
    provider: z.string().optional(),
    endpointUrl: z.string().optional(),
    providerStructure: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().min(1).max(200_000).optional(),
    supportsTools: z.boolean().optional(),
    supportsStreaming: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
    supportsStructured: z.boolean().optional(),
    capabilities: z.array(z.enum(VALID_FEATURE_CAPABILITIES)).optional(),
    realtimeConfig: z.record(z.unknown()).optional(),
    tier: z.string().optional(),
    isDefault: z.boolean().optional(),
    provisioningNote: z.string().max(MAX_NOTE_LENGTH).optional(),
    connection: z
      .object({
        credentialName: z.string().max(MAX_FIELD_LENGTH),
        apiKey: z.string().min(1),
        authType: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const updateTenantModelSchema = z
  .object({
    displayName: z.string().max(MAX_FIELD_LENGTH).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().min(1).max(200_000).optional(),
    tier: z.string().optional(),
    isDefault: z.boolean().optional(),
    supportsTools: z.boolean().optional(),
    supportsStreaming: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
    supportsStructured: z.boolean().optional(),
    capabilities: z.array(z.enum(VALID_FEATURE_CAPABILITIES)).optional(),
    realtimeConfig: z.record(z.unknown()).nullable().optional(),
    provisioningNote: z.string().max(MAX_NOTE_LENGTH).nullable().optional(),
    isActive: z.boolean().optional(),
    inferenceEnabled: z.boolean().optional(),
  })
  .strict();

export const createTenantModelConnectionSchema = z
  .object({
    credentialName: z.string().min(1).max(MAX_FIELD_LENGTH),
    apiKey: z.string().min(1),
    authType: z.string().optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict();

const retentionDaysSchema = z
  .record(
    z.enum(VALID_ATTACHMENT_RETENTION_KINDS),
    z.number().int().min(MIN_RETENTION_DAYS).max(MAX_RETENTION_DAYS),
  )
  .optional();

export const tenantAttachmentConfigUpdateSchema = z
  .object({
    maxFileSizeBytes: z
      .number()
      .min(MIN_MAX_FILE_SIZE_BYTES)
      .max(MAX_MAX_FILE_SIZE_BYTES)
      .optional(),
    allowedMimeTypes: z.array(z.string().min(1)).max(MAX_MIME_TYPE_LIST_LENGTH).optional(),
    blockedMimeTypes: z.array(z.string().min(1)).max(MAX_MIME_TYPE_LIST_LENGTH).optional(),
    scanEnabled: z.boolean().optional(),
    processingEnabled: z.boolean().optional(),
    embeddingEnabled: z.boolean().optional(),
    maxAttachmentsPerSession: z
      .number()
      .int()
      .min(1)
      .max(MAX_ATTACHMENTS_PER_SESSION_CEILING)
      .optional(),
    maxTotalStorageBytes: z.number().min(1).max(MAX_TOTAL_STORAGE_BYTES_CEILING).optional(),
    retentionDays: retentionDaysSchema,
  })
  .strict();

export const tenantConfigOverridesSchema = z.record(
  z.enum(VALID_LIMIT_KEYS),
  z.number({ invalid_type_error: 'Override values must be numeric' }),
);

export const deleteTenantConfigOverridesSchema = z
  .object({
    keys: z.array(z.string().min(1)).optional(),
  })
  .strict();
