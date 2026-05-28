/**
 * Template Repository
 *
 * Standalone query functions for browsing, searching, and retrieving templates.
 * All browse queries enforce { status: 'published', visibility: 'public' } filter.
 *
 * Uses dynamic import to avoid loading Mongoose models before DB is ready.
 */

import { createLogger } from '@agent-platform/shared-observability';
import type { ITemplate, ITemplateVersion } from '@agent-platform/database/models';

const log = createLogger('template-repo');

// ─── Types ────────────────────────────────────────────────────────────────

export interface BrowseQuery {
  page: number;
  limit: number;
  type?: 'agent' | 'project';
  category?: string;
  complexity?: 'starter' | 'standard' | 'advanced';
  q?: string;
  sort: 'popular' | 'rating' | 'newest' | 'updated';
  /** Authenticated user's tenantId — scopes results to platform + tenant templates */
  tenantId?: string;
  /** Filter by specific publisher tenant IDs (e.g., ['platform', 'tenant-123']) */
  publisherTenantIds?: string[];
}

export interface BrowseResult {
  templates: ITemplate[];
  total: number;
}

// ─── Sort Mapping ─────────────────────────────────────────────────────────

const SORT_MAP: Record<BrowseQuery['sort'], Record<string, 1 | -1>> = {
  popular: { installCount: -1, createdAt: -1 },
  rating: { ratingAverage: -1, createdAt: -1 },
  newest: { createdAt: -1 },
  updated: { updatedAt: -1, createdAt: -1 },
};

// ─── Base Filter ──────────────────────────────────────────────────────────

/** All browse queries enforce published + public + approved */
const BASE_FILTER = { status: 'published', visibility: 'public', reviewStatus: 'approved' };

// ─── Repository Functions ─────────────────────────────────────────────────

/**
 * Find templates with filters, pagination, and sorting.
 * Supports text search via MongoDB $text operator.
 */
export async function findTemplates(options: BrowseQuery): Promise<BrowseResult> {
  const { Template } = await import('@agent-platform/database/models');

  const filter: Record<string, unknown> = { ...BASE_FILTER };

  // Tenant scoping: publisherTenantIds takes priority, then tenantId, then public-only
  if (options.publisherTenantIds && options.publisherTenantIds.length > 0) {
    filter.publisherTenantId = { $in: options.publisherTenantIds };
  } else if (options.tenantId) {
    filter.publisherTenantId = { $in: ['platform', options.tenantId] };
  } else {
    filter.publisherTenantId = 'platform';
  }

  if (options.type) {
    filter.type = options.type;
  }
  if (options.category) {
    filter.category = options.category;
  }
  if (options.complexity) {
    filter.complexity = options.complexity;
  }
  if (options.q) {
    filter.$text = { $search: options.q };
  }

  const skip = (options.page - 1) * options.limit;

  // When using text search, sort by textScore first for relevance
  let sortSpec: Record<string, unknown>;
  if (options.q) {
    sortSpec = { score: { $meta: 'textScore' }, ...SORT_MAP[options.sort] };
  } else {
    sortSpec = SORT_MAP[options.sort];
  }

  const [templates, total] = await Promise.all([
    Template.find(filter).sort(sortSpec).skip(skip).limit(options.limit).lean().exec() as Promise<
      ITemplate[]
    >,
    Template.countDocuments(filter).exec(),
  ]);

  log.debug('findTemplates completed', {
    total,
    page: options.page,
    limit: options.limit,
    hasQuery: !!options.q,
    tenantId: options.tenantId ?? 'none',
    publisherFilter: filter.publisherTenantId,
  });

  return { templates, total };
}

/**
 * Find a single template by its URL-safe slug.
 * Returns null if not found or not published/public.
 */
export async function findTemplateBySlug(
  slug: string,
  tenantId?: string,
): Promise<ITemplate | null> {
  const { Template } = await import('@agent-platform/database/models');

  const filter: Record<string, unknown> = { slug, ...BASE_FILTER };
  if (tenantId) {
    filter.publisherTenantId = { $in: ['platform', tenantId] };
  } else {
    filter.publisherTenantId = 'platform';
  }

  const template = (await Template.findOne(filter).lean().exec()) as ITemplate | null;

  return template;
}

/**
 * Find featured templates, ordered by featuredOrder ascending.
 * Only includes published+public templates with a non-null featuredOrder.
 */
export async function findFeaturedTemplates(tenantId?: string): Promise<ITemplate[]> {
  const { Template } = await import('@agent-platform/database/models');

  const filter: Record<string, unknown> = {
    ...BASE_FILTER,
    featuredOrder: { $ne: null },
  };
  if (tenantId) {
    filter.publisherTenantId = { $in: ['platform', tenantId] };
  } else {
    filter.publisherTenantId = 'platform';
  }

  const templates = (await Template.find(filter)
    .sort({ featuredOrder: 1 })
    .limit(50)
    .lean()
    .exec()) as ITemplate[];

  log.debug('findFeaturedTemplates completed', { count: templates.length });

  return templates;
}

/**
 * Get category names with template counts via aggregation pipeline.
 * Only counts published+public templates.
 */
export async function findCategories(
  type?: 'agent' | 'project',
  tenantId?: string,
): Promise<Array<{ name: string; count: number }>> {
  const { Template } = await import('@agent-platform/database/models');

  const matchFilter: Record<string, unknown> = { ...BASE_FILTER };
  if (tenantId) {
    matchFilter.publisherTenantId = { $in: ['platform', tenantId] };
  } else {
    matchFilter.publisherTenantId = 'platform';
  }
  if (type) {
    matchFilter.type = type;
  }

  const categories = (await Template.aggregate([
    { $match: matchFilter },
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $project: { _id: 0, name: '$_id', count: 1 } },
    { $sort: { count: -1 } },
  ]).exec()) as Array<{ name: string; count: number }>;

  log.debug('findCategories completed', { count: categories.length, type });

  return categories;
}

/**
 * Atomically increment the view count for a template.
 */
export async function incrementViewCount(templateId: string): Promise<void> {
  const { Template } = await import('@agent-platform/database/models');

  await Template.updateOne({ _id: templateId }, { $inc: { viewCount: 1 } }).exec();

  log.debug('incrementViewCount', { templateId });
}

/**
 * Atomically increment the install count for a template by slug.
 * Uses BASE_FILTER to ensure only published+public+approved templates are updated.
 */
export async function incrementInstallCount(slug: string): Promise<void> {
  const { Template } = await import('@agent-platform/database/models');

  await Template.updateOne({ slug, ...BASE_FILTER }, { $inc: { installCount: 1 } }).exec();

  log.debug('incrementInstallCount', { slug });
}

/**
 * Find the files bundle for a specific template version.
 * Returns ONLY the files field — used for install-time bundle retrieval.
 * Enforces published + public template status.
 */
export async function findBundleBySlugAndVersion(
  slug: string,
  version: string,
  tenantId?: string,
): Promise<{ files: Record<string, string> } | null> {
  const { Template, TemplateVersion } = await import('@agent-platform/database/models');

  // First, find the template by slug (enforce published + public + approved + tenant scope)
  const templateFilter: Record<string, unknown> = { slug, ...BASE_FILTER };
  if (tenantId) {
    templateFilter.publisherTenantId = { $in: ['platform', tenantId] };
  } else {
    templateFilter.publisherTenantId = 'platform';
  }

  const template = (await Template.findOne(templateFilter).select('_id').lean().exec()) as {
    _id: string;
  } | null;

  if (!template) {
    return null;
  }

  // Find the specific version and return only files
  const versionDoc = (await TemplateVersion.findOne({
    templateId: template._id,
    version,
    status: 'published',
  })
    .select('files')
    .lean()
    .exec()) as { files: Record<string, string> | null } | null;

  if (!versionDoc || !versionDoc.files) {
    return null;
  }

  log.debug('findBundleBySlugAndVersion', {
    slug,
    version,
    fileCount: Object.keys(versionDoc.files).length,
  });

  return { files: versionDoc.files };
}

/**
 * Find the latest published version for a template.
 */
export async function findLatestPublishedVersion(
  templateId: string,
): Promise<ITemplateVersion | null> {
  const { TemplateVersion } = await import('@agent-platform/database/models');

  const version = (await TemplateVersion.findOne({
    templateId,
    status: 'published',
  })
    .select('-files') // Phase 2: exclude files from browse/detail responses
    .sort({ createdAt: -1 })
    .lean()
    .exec()) as ITemplateVersion | null;

  log.debug('findLatestPublishedVersion', { templateId, found: !!version });

  return version;
}

// ─── Admin Repository Functions ──────────────────────────────────────────

/**
 * Find templates for admin management (no BASE_FILTER).
 * Filters by publisherTenantId for ownership scoping.
 */
export async function findTemplatesForAdmin(opts: {
  publisherTenantId: string;
  status?: string;
  page?: number;
  limit?: number;
}): Promise<{ templates: ITemplate[]; total: number }> {
  const { Template } = await import('@agent-platform/database/models');

  const page = opts.page ?? 1;
  const limit = opts.limit ?? 20;
  const filter: Record<string, unknown> = { publisherTenantId: opts.publisherTenantId };

  if (opts.status) {
    filter.status = opts.status;
  }

  const skip = (page - 1) * limit;

  const [templates, total] = await Promise.all([
    Template.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean().exec() as Promise<
      ITemplate[]
    >,
    Template.countDocuments(filter).exec(),
  ]);

  log.debug('findTemplatesForAdmin completed', {
    total,
    page,
    limit,
    publisherTenantId: opts.publisherTenantId,
  });

  return { templates, total };
}

/**
 * Find a template by ID for admin management (no BASE_FILTER).
 * Verifies ownership via publisherTenantId.
 */
export async function findTemplateByIdForAdmin(
  id: string,
  publisherTenantId: string,
): Promise<ITemplate | null> {
  const { Template } = await import('@agent-platform/database/models');

  const template = (await Template.findOne({ _id: id, publisherTenantId })
    .lean()
    .exec()) as ITemplate | null;

  log.debug('findTemplateByIdForAdmin', { id, publisherTenantId, found: !!template });

  return template;
}

/**
 * Update template metadata fields.
 * Returns the updated document or null if not found.
 */
export async function updateTemplate(
  id: string,
  publisherTenantId: string,
  updates: Partial<ITemplate>,
): Promise<ITemplate | null> {
  const { Template } = await import('@agent-platform/database/models');

  const template = (await Template.findOneAndUpdate(
    { _id: id, publisherTenantId },
    { $set: updates },
    { new: true },
  )
    .lean()
    .exec()) as ITemplate | null;

  log.debug('updateTemplate', { id, publisherTenantId, updated: !!template });

  return template;
}

/**
 * Archive a template (soft-delete) by setting status to 'archived'.
 */
export async function archiveTemplate(id: string, publisherTenantId: string): Promise<boolean> {
  const { Template } = await import('@agent-platform/database/models');

  const result = await Template.updateOne(
    { _id: id, publisherTenantId },
    { $set: { status: 'archived' } },
  ).exec();

  const archived = result.modifiedCount > 0;
  log.debug('archiveTemplate', { id, publisherTenantId, archived });

  return archived;
}

/**
 * Create a new template document.
 */
export async function createTemplate(data: Partial<ITemplate>): Promise<ITemplate> {
  const { Template } = await import('@agent-platform/database/models');

  const template = await Template.create(data);
  const doc = template.toObject() as ITemplate;

  log.debug('createTemplate', { id: doc._id, slug: doc.slug, name: doc.name });

  return doc;
}

/**
 * Create a new template version document.
 */
export async function createTemplateVersion(
  data: Partial<ITemplateVersion>,
): Promise<ITemplateVersion> {
  const { TemplateVersion } = await import('@agent-platform/database/models');

  const version = await TemplateVersion.create(data);
  const doc = version.toObject() as ITemplateVersion;

  log.debug('createTemplateVersion', {
    id: doc._id,
    templateId: doc.templateId,
    version: doc.version,
  });

  return doc;
}

/**
 * Check if a template with the given slug already exists.
 */
export async function findTemplateBySlugUnfiltered(slug: string): Promise<ITemplate | null> {
  const { Template } = await import('@agent-platform/database/models');

  const template = (await Template.findOne({ slug }).lean().exec()) as ITemplate | null;

  return template;
}
