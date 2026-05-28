/**
 * Platform Admin — Tenant Management Routes
 *
 * System admins list, view, and manage tenants across the platform.
 * Includes tenant listing with enrichment (subscription plan, member count),
 * individual tenant detail, and status management.
 *
 * Key rules:
 * - All routes require `requirePlatformAdmin()` — only super-admins
 * - `tenantId` comes from the URL path — admin operates outside any tenant
 * - Every mutation writes an audit log with `platform-admin:` prefix
 *
 * Mount: /api/platform/admin/tenants
 */

import { Router } from 'express';
import type mongoose from 'mongoose';
import { z } from 'zod';
import { requirePlatformAdmin, requirePlatformAdminIp } from '@agent-platform/shared-auth';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { withTransaction } from '@agent-platform/shared/repos';
import { createLogger } from '@abl/compiler/platform';
import { getConfig } from '../config/index.js';
import { platformAdminAuthMiddleware } from '../middleware/auth.js';
import { writeAuditLog } from '../repos/auth-repo.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { getTenantConfigService } from '../services/tenant-config.js';

const log = createLogger('platform-admin-tenants');
const router: ReturnType<typeof Router> = Router();

// ─── Middleware ────────────────────────────────────────────────────────────

router.use(platformAdminAuthMiddleware);
router.use(tenantRateLimit('request'));
router.use(requirePlatformAdmin());
router.use(requirePlatformAdminIp(() => getConfig().security.platformAdminAllowedIps));

// ─── Validation ───────────────────────────────────────────────────────────

const VALID_STATUSES = ['active', 'suspended', 'archived'] as const;
const VALID_PLAN_TIERS = ['FREE', 'TEAM', 'BUSINESS', 'ENTERPRISE'] as const;
const VALID_MEMBER_ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;

const statusChangeSchema = z.object({
  status: z.enum(VALID_STATUSES),
});

const subscriptionChangeSchema = z.object({
  planTier: z.enum(VALID_PLAN_TIERS),
});

const addMemberSchema = z.object({
  email: z.string().email('Invalid email address'),
  role: z.enum(VALID_MEMBER_ROLES),
});

const updateMemberRoleSchema = z.object({
  role: z.enum(VALID_MEMBER_ROLES),
});

const createTenantSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  slug: z
    .string()
    .min(1, 'Slug is required')
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens'),
  planTier: z.enum(VALID_PLAN_TIERS).default('FREE'),
});

const createProjectSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  slug: z
    .string()
    .min(1, 'Slug is required')
    .max(200)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens'),
});

// ─── Constants ────────────────────────────────────────────────────────────

/** Default page size for list endpoints */
const PAGINATION_DEFAULT_LIMIT = 25;

/** Maximum page size for list endpoints */
const PAGINATION_MAX_LIMIT = 100;

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Parse pagination params with sensible defaults and caps. */
function parsePagination(query: Record<string, unknown>): {
  page: number;
  limit: number;
  skip: number;
} {
  const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
  const limit = Math.min(
    PAGINATION_MAX_LIMIT,
    Math.max(
      1,
      parseInt(String(query.limit ?? String(PAGINATION_DEFAULT_LIMIT)), 10) ||
        PAGINATION_DEFAULT_LIMIT,
    ),
  );
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

async function ensureTenantOperationalDefaults(
  tenantId: string,
  createdBy: string,
  session?: mongoose.ClientSession | null,
): Promise<void> {
  const [{ seedTenantBootstrapDefaults }, { seedTenantPipelineConfigs }] = await Promise.all([
    import('@agent-platform/database'),
    import('@agent-platform/pipeline-engine'),
  ]);

  await seedTenantBootstrapDefaults({ tenantId, createdBy, session });
  await seedTenantPipelineConfigs({ tenantId, createdBy, session });
}

// ─── GET / — List tenants ─────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { Tenant, Subscription, TenantMember } = await import('@agent-platform/database/models');
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);

    // Build filter from query params
    const filter: Record<string, unknown> = {};

    const statusParam = req.query.status as string | undefined;
    if (statusParam) {
      if (!(VALID_STATUSES as readonly string[]).includes(statusParam)) {
        res.status(400).json({
          success: false,
          error: `Invalid status filter. Allowed: ${VALID_STATUSES.join(', ')}`,
        });
        return;
      }
      filter.status = statusParam;
    }

    const searchParam = req.query.search as string | undefined;
    if (searchParam) {
      const escaped = searchParam.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.name = { $regex: escaped, $options: 'i' };
    }

    // planTier filter requires a join strategy — we filter post-query
    const planTierParam = req.query.planTier as string | undefined;

    const [tenants, total] = await Promise.all([
      Tenant.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean().exec(),
      Tenant.countDocuments(filter).exec(),
    ]);

    // Enrich each tenant with subscription planTier and member count
    const tenantIds = tenants.map((t: any) => t._id);

    const [subscriptions, memberCounts] = await Promise.all([
      Subscription.find(
        { tenantId: { $in: tenantIds }, status: 'active' },
        { tenantId: 1, planTier: 1 },
      )
        .lean()
        .exec(),
      TenantMember.aggregate([
        { $match: { tenantId: { $in: tenantIds } } },
        { $group: { _id: '$tenantId', count: { $sum: 1 } } },
      ]).exec(),
    ]);

    // Build lookup maps — use String() to normalise ObjectId → string
    const subscriptionMap = new Map<string, string>();
    for (const sub of subscriptions) {
      subscriptionMap.set(String((sub as any).tenantId), (sub as any).planTier);
    }

    const memberCountMap = new Map<string, number>();
    for (const mc of memberCounts) {
      memberCountMap.set(String((mc as any)._id), (mc as any).count);
    }

    // Build enriched tenant list
    let enrichedTenants = tenants.map((tenant: any) => ({
      ...tenant,
      _id: String(tenant._id),
      planTier: subscriptionMap.get(String(tenant._id)) ?? null,
      memberCount: memberCountMap.get(String(tenant._id)) ?? 0,
    }));

    // Apply planTier filter post-query if specified
    if (planTierParam) {
      enrichedTenants = enrichedTenants.filter((t: any) => t.planTier === planTierParam);
    }

    res.json({
      success: true,
      tenants: enrichedTenants,
      pagination: {
        page,
        limit,
        total: planTierParam ? enrichedTenants.length : total,
        totalPages: Math.ceil((planTierParam ? enrichedTenants.length : total) / limit),
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to list tenants', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to list tenants' });
  }
});

// ─── POST / — Create tenant ───────────────────────────────────────────────

router.post('/', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const parsed = createTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid tenant data',
        details: parsed.error.issues,
      });
      return;
    }

    const { name, slug, planTier } = parsed.data;
    const { Tenant, Subscription, TenantMember } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    // Check for duplicate slug
    const existing = await Tenant.findOne({ slug }).lean().exec();
    if (existing) {
      res.status(409).json({ success: false, error: 'A tenant with this slug already exists' });
      return;
    }

    const tenant = await withTransaction(async (session) => {
      const opts = session ? { session } : {};

      const [createdTenant] = await Tenant.create(
        [
          {
            name,
            slug,
            ownerId: adminUserId,
            status: 'active',
          },
        ],
        opts,
      );

      await TenantMember.create(
        [
          {
            tenantId: String(createdTenant._id),
            userId: adminUserId,
            role: 'OWNER',
            customRoleId: null,
          },
        ],
        opts,
      );

      await Subscription.create(
        [
          {
            tenantId: String(createdTenant._id),
            planTier,
            billingCycle: 'monthly',
            billingStartDate: new Date(),
            status: 'active',
            entitlements: [],
          },
        ],
        opts,
      );

      await ensureTenantOperationalDefaults(String(createdTenant._id), adminUserId, session);

      return createdTenant;
    });

    log.info('Tenant created', {
      tenantId: String(tenant._id),
      slug,
      planTier,
      adminUserId,
      requestId,
    });
    writeAuditLog({
      action: 'platform-admin:create-tenant',
      userId: adminUserId,
      tenantId: String(tenant._id),
      metadata: { name, slug, planTier, requestId },
    });

    res.status(201).json({
      success: true,
      tenant: {
        ...tenant.toObject(),
        _id: String(tenant._id),
        planTier,
        memberCount: 1,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to create tenant', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to create tenant' });
  }
});

// ─── GET /:tenantId — Tenant detail ───────────────────────────────────────

router.get('/:tenantId', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { tenantId } = req.params;
    const { Tenant, Subscription, TenantMember } = await import('@agent-platform/database/models');

    const [tenant, subscription, memberCount] = await Promise.all([
      Tenant.findOne({ _id: tenantId }).lean().exec(),
      Subscription.findOne(
        { tenantId, status: 'active' },
        {
          planTier: 1,
          tenantId: 1,
          billingCycle: 1,
          billingStartDate: 1,
          billingEndDate: 1,
          entitlements: 1,
        },
      )
        .lean()
        .exec(),
      TenantMember.countDocuments({ tenantId }).exec(),
    ]);

    if (!tenant) {
      res.status(404).json({ success: false, error: 'Tenant not found' });
      return;
    }

    res.json({
      success: true,
      tenant,
      subscription: subscription ?? null,
      memberCount,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to get tenant detail', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to get tenant detail' });
  }
});

// ─── PATCH /:tenantId/status — Change tenant status ──────────────────────

router.patch('/:tenantId/status', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { tenantId } = req.params;
    const parsed = statusChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid status value',
        details: parsed.error.issues,
      });
      return;
    }

    const { status } = parsed.data;
    const { Tenant } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    const tenant = await Tenant.findOneAndUpdate({ _id: tenantId }, { status }, { new: true })
      .lean()
      .exec();

    if (!tenant) {
      res.status(404).json({ success: false, error: 'Tenant not found' });
      return;
    }

    // Invalidate tenant config cache so status change takes effect immediately
    const statusConfigService = getTenantConfigService();
    await statusConfigService.invalidateCache(tenantId);

    log.info('Tenant status changed', { tenantId, status, adminUserId, requestId });
    writeAuditLog({
      action: 'platform-admin:change-tenant-status',
      userId: adminUserId,
      tenantId,
      metadata: { status, requestId },
    });

    res.json({ success: true, tenant });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to change tenant status', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to change tenant status' });
  }
});

// ─── PATCH /:tenantId/subscription — Change tenant plan tier ─────────────

router.patch('/:tenantId/subscription', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { tenantId } = req.params;
    const parsed = subscriptionChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid plan tier',
        details: parsed.error.issues,
      });
      return;
    }

    const { planTier } = parsed.data;
    const { Tenant, Subscription } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    const tenant = await Tenant.findOne({ _id: tenantId }).lean().exec();
    if (!tenant) {
      res.status(404).json({ success: false, error: 'Tenant not found' });
      return;
    }

    const subscription = await Subscription.findOneAndUpdate(
      { tenantId, status: 'active' },
      {
        $set: { planTier, updatedAt: new Date() },
        $setOnInsert: {
          tenantId,
          status: 'active',
          billingCycle: 'monthly',
          billingStartDate: new Date(),
          entitlements: [],
          tenantQuotas: [],
          _v: 1,
          createdAt: new Date(),
        },
      },
      { upsert: true, new: true },
    )
      .lean()
      .exec();

    // Invalidate tenant config cache so plan change takes effect immediately
    const configService = getTenantConfigService();
    await configService.invalidateCache(tenantId);

    log.info('Tenant subscription updated', { tenantId, planTier, adminUserId, requestId });
    writeAuditLog({
      action: 'platform-admin:change-subscription',
      userId: adminUserId,
      tenantId,
      metadata: { planTier, requestId },
    });

    res.json({ success: true, subscription });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to update subscription', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to update subscription' });
  }
});

// ─── GET /:tenantId/members — List tenant members ────────────────────────

router.get('/:tenantId/members', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { tenantId } = req.params;
    const { TenantMember, User } = await import('@agent-platform/database/models');

    const members = await TenantMember.find({ tenantId }).lean().exec();

    if (members.length === 0) {
      res.json({ success: true, members: [], total: 0 });
      return;
    }

    // Batch-fetch users by userId
    const userIds = members.map((m: any) => m.userId);
    const users = await User.find({ _id: { $in: userIds } }, { _id: 1, email: 1, name: 1 })
      .lean()
      .exec();

    const userMap = new Map<string, { email: string; name: string | null }>();
    for (const user of users) {
      userMap.set(String((user as any)._id), {
        email: (user as any).email,
        name: (user as any).name,
      });
    }

    const enrichedMembers = members.map((member: any) => {
      const user = userMap.get(String(member.userId));
      return {
        userId: member.userId,
        email: user?.email ?? 'unknown',
        name: user?.name ?? null,
        role: member.role,
        joinedAt: member.createdAt,
      };
    });

    res.json({ success: true, members: enrichedMembers, total: enrichedMembers.length });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to list tenant members', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to list tenant members' });
  }
});

// ─── POST /:tenantId/members — Add member to tenant ──────────────────────

router.post('/:tenantId/members', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { tenantId } = req.params;
    const parsed = addMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid member data',
        details: parsed.error.issues,
      });
      return;
    }

    const { email, role } = parsed.data;
    const { Tenant, TenantMember, User } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    // Verify tenant exists
    const tenant = await Tenant.findOne({ _id: tenantId }).lean().exec();
    if (!tenant) {
      res.status(404).json({ success: false, error: 'Tenant not found' });
      return;
    }

    // Look up the user by email
    const user = await User.findOne({ email }, { _id: 1, email: 1, name: 1 }).lean().exec();
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found with this email' });
      return;
    }

    const userId = String((user as any)._id);

    // Check if user is already a member of this tenant
    const existingMember = await TenantMember.findOne({ tenantId, userId }).lean().exec();
    if (existingMember) {
      res.status(409).json({ success: false, error: 'User is already a member of this tenant' });
      return;
    }

    // Create the tenant membership
    const member = await TenantMember.create({
      tenantId,
      userId,
      role,
    });

    log.info('Member added to tenant', {
      tenantId,
      userId,
      email,
      role,
      adminUserId,
      requestId,
    });
    writeAuditLog({
      action: 'platform-admin:add-tenant-member',
      userId: adminUserId,
      tenantId,
      metadata: { memberId: userId, email, role, requestId },
    });

    res.status(201).json({
      success: true,
      member: {
        userId,
        email: (user as any).email,
        name: (user as any).name ?? null,
        role: member.role,
        joinedAt: member.createdAt,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to add tenant member', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to add tenant member' });
  }
});

// ─── DELETE /:tenantId/members/:userId — Remove member from tenant ────────

router.delete('/:tenantId/members/:userId', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { tenantId, userId } = req.params;
    const { TenantMember } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    // Find and remove the membership
    const member = await TenantMember.findOneAndDelete({ tenantId, userId }).lean().exec();
    if (!member) {
      res.status(404).json({ success: false, error: 'Member not found in this tenant' });
      return;
    }

    log.info('Member removed from tenant', {
      tenantId,
      userId,
      adminUserId,
      requestId,
    });
    writeAuditLog({
      action: 'platform-admin:remove-tenant-member',
      userId: adminUserId,
      tenantId,
      metadata: { memberId: userId, previousRole: (member as any).role, requestId },
    });

    res.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to remove tenant member', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to remove tenant member' });
  }
});

// ─── PATCH /:tenantId/members/:userId — Update member role ────────────────

router.patch('/:tenantId/members/:userId', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { tenantId, userId } = req.params;
    const parsed = updateMemberRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid role value',
        details: parsed.error.issues,
      });
      return;
    }

    const { role } = parsed.data;
    const { TenantMember } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    // Find the existing membership to capture the previous role
    const existingMember = await TenantMember.findOne({ tenantId, userId }).lean().exec();
    if (!existingMember) {
      res.status(404).json({ success: false, error: 'Member not found in this tenant' });
      return;
    }

    const previousRole = (existingMember as any).role;

    // Update the role
    const updatedMember = await TenantMember.findOneAndUpdate(
      { tenantId, userId },
      { role },
      { new: true },
    )
      .lean()
      .exec();

    log.info('Member role updated', {
      tenantId,
      userId,
      previousRole,
      newRole: role,
      adminUserId,
      requestId,
    });
    writeAuditLog({
      action: 'platform-admin:update-tenant-member-role',
      userId: adminUserId,
      tenantId,
      metadata: { memberId: userId, previousRole, newRole: role, requestId },
    });

    res.json({
      success: true,
      member: {
        userId: (updatedMember as any).userId,
        role: (updatedMember as any).role,
        joinedAt: (updatedMember as any).createdAt,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to update tenant member role', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to update tenant member role' });
  }
});

// ─── GET /:tenantId/projects — List tenant projects ──────────────────────

router.get('/:tenantId/projects', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { tenantId } = req.params;
    const { Project, ProjectAgent } = await import('@agent-platform/database/models');

    const projects = await Project.find({ tenantId }).sort({ createdAt: -1 }).lean().exec();

    if (projects.length === 0) {
      res.json({ success: true, projects: [], total: 0 });
      return;
    }

    // Count agents per project using aggregate
    const projectIds = projects.map((p: any) => String(p._id));
    const agentCounts = await ProjectAgent.aggregate([
      { $match: { projectId: { $in: projectIds } } },
      { $group: { _id: '$projectId', count: { $sum: 1 } } },
    ]).exec();

    const agentCountMap = new Map<string, number>();
    for (const ac of agentCounts) {
      agentCountMap.set(String((ac as any)._id), (ac as any).count);
    }

    const enrichedProjects = projects.map((project: any) => ({
      _id: String(project._id),
      name: project.name,
      slug: project.slug,
      agentCount: agentCountMap.get(String(project._id)) ?? 0,
      createdAt: project.createdAt,
    }));

    res.json({ success: true, projects: enrichedProjects, total: enrichedProjects.length });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to list tenant projects', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to list tenant projects' });
  }
});

// ─── POST /:tenantId/projects — Create project for tenant ─────────────

router.post('/:tenantId/projects', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { tenantId } = req.params;
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid project data',
        details: parsed.error.issues,
      });
      return;
    }

    const { name, slug } = parsed.data;
    const { Tenant, Project } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    // Verify tenant exists
    const tenant = await Tenant.findOne({ _id: tenantId }).lean().exec();
    if (!tenant) {
      res.status(404).json({ success: false, error: 'Tenant not found' });
      return;
    }

    // Check for duplicate slug within tenant
    const existing = await Project.findOne({ tenantId, slug }).lean().exec();
    if (existing) {
      res.status(409).json({
        success: false,
        error: 'A project with this slug already exists in this tenant',
      });
      return;
    }

    // Create project
    const project = await Project.create({
      name,
      slug,
      tenantId,
      ownerId: adminUserId,
    });

    log.info('Project created for tenant', {
      projectId: String(project._id),
      tenantId,
      slug,
      adminUserId,
      requestId,
    });
    writeAuditLog({
      action: 'platform-admin:create-project',
      userId: adminUserId,
      tenantId,
      metadata: { projectId: String(project._id), name, slug, requestId },
    });

    res.status(201).json({
      success: true,
      project: {
        _id: String(project._id),
        name: project.name,
        slug: project.slug,
        tenantId: project.tenantId,
        createdAt: project.createdAt,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to create project for tenant', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to create project' });
  }
});

// ─── DELETE /:tenantId/projects/:projectId — Delete tenant project ────

router.delete('/:tenantId/projects/:projectId', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { tenantId, projectId } = req.params;
    const { Project } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    // Find the project and verify it belongs to the tenant
    const project = await Project.findOne({ _id: projectId, tenantId }).lean().exec();
    if (!project) {
      res.status(404).json({ success: false, error: 'Project not found' });
      return;
    }

    await Project.deleteOne({ _id: projectId, tenantId }).exec();

    log.info('Project deleted', {
      projectId,
      tenantId,
      adminUserId,
      requestId,
    });
    writeAuditLog({
      action: 'platform-admin:delete-project',
      userId: adminUserId,
      tenantId,
      metadata: { projectId, projectName: (project as any).name, requestId },
    });

    res.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to delete project', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to delete project' });
  }
});

// ─── PATCH /:tenantId/features — Toggle tenant feature flags ────────────────

const PatchFeaturesSchema = z.object({
  codeToolsEnabled: z.boolean().optional(),
});

router.patch('/:tenantId/features', async (req, res) => {
  const { tenantId } = req.params;
  const parse = PatchFeaturesSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_INPUT', message: parse.error.message },
    });
    return;
  }

  const updates = parse.data;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'No feature flags provided' },
    });
    return;
  }

  try {
    const { Tenant } = await import('@agent-platform/database/models');

    // Ensure settings is not null — MongoDB cannot $set dot-notation fields
    // inside a null value ("Cannot create field 'x' in element {settings: null}").
    await Tenant.updateOne({ _id: tenantId, settings: null }, { $set: { settings: {} } });

    const setOps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        setOps[`settings.${key}`] = value;
      }
    }

    const tenant = await Tenant.findOneAndUpdate({ _id: tenantId }, { $set: setOps }, { new: true })
      .lean()
      .exec();

    if (!tenant) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Tenant not found' },
      });
      return;
    }

    // Invalidate Redis config cache
    try {
      const { getTenantConfigService } = await import('../services/tenant-config.js');
      const configService = getTenantConfigService();
      await configService.invalidateCache(tenantId);
    } catch (cacheErr) {
      log.warn('Failed to invalidate tenant config cache', {
        tenantId,
        error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
      });
    }

    log.info('Tenant feature flags updated', { tenantId, updates });

    res.json({
      success: true,
      data: { tenantId, settings: (tenant as any).settings },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to update tenant features', { tenantId, error: message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update tenant features' },
    });
  }
});

export default router;
