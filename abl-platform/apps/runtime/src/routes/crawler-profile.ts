/**
 * Crawler Profile REST API
 *
 * Zero-config site profiling with automatic caching.
 * Profiles are stored per-tenant and cached for 90 days.
 *
 * Endpoints:
 * - POST /api/crawler/profile — Profile a URL (with caching)
 * - GET /api/crawler/profile/:domain — Get cached profile
 * - GET /api/crawler/patterns — List all patterns for tenant
 * - DELETE /api/crawler/profile/:domain — Delete cached profile
 * - GET /api/crawler/stats — Get profiling statistics
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { getCurrentTenantId } from '@agent-platform/shared-auth/middleware';
import {
  createCachedProfiler,
  MongoPatternStore,
  type SiteProfile,
  type StoredPattern,
} from '@abl/crawler';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('crawler-profile-route');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/crawler',
  tags: ['Crawler'],
});
const router: RouterType = openapi.router;

// All crawler routes require authentication
router.use(authMiddleware);

// Initialize profiler and pattern store
const profiler = createCachedProfiler({ ttlMs: 60 * 60 * 1000, maxSize: 1000 });
const patternStore = new MongoPatternStore();

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const siteProfileSchema = z.object({
  domain: z.string().describe('Domain name'),
  profiledAt: z.string().datetime().describe('When site was profiled'),
  siteType: z.enum(['static', 'spa', 'hybrid', 'unknown']).describe('Site type classification'),
  framework: z.string().optional().describe('Detected JavaScript framework'),
  jsRequired: z.boolean().describe('Whether JavaScript is required for content'),
  linkDensity: z.number().describe('Number of internal links'),
  estimatedSize: z.number().describe('Estimated number of pages'),
  avgResponseTime: z.number().describe('Average response time in ms'),
  rateLimitDetected: z.boolean().describe('Whether rate limiting was detected'),
  maxConcurrency: z.number().describe('Recommended max concurrent requests'),
  confidence: z.number().min(0).max(100).describe('Confidence score (0-100)'),
  metadata: z.record(z.any()).describe('Additional metadata'),
});

const crawlMetricsSchema = z.object({
  lastCrawlAt: z.string().datetime().optional().describe('Last crawl timestamp'),
  totalCrawlsCompleted: z.number().describe('Total number of crawls completed'),
  avgCrawlDurationMs: z.number().optional().describe('Average crawl duration in ms'),
  lastCrawlSuccess: z.boolean().describe('Whether last crawl succeeded'),
  lastCrawlError: z.string().optional().describe('Last crawl error message'),
});

const storedPatternSchema = z.object({
  id: z.string().describe('Pattern ID'),
  domain: z.string().describe('Domain name'),
  tenantId: z.string().describe('Tenant ID'),
  profile: siteProfileSchema.describe('Site profile'),
  crawlMetrics: crawlMetricsSchema.describe('Crawl performance metrics'),
  profiledAt: z.string().datetime().describe('When pattern was created'),
  lastAccessedAt: z.string().datetime().describe('Last access time'),
  createdAt: z.string().datetime().describe('Creation timestamp'),
  updatedAt: z.string().datetime().describe('Last update timestamp'),
});

const profileRequestSchema = z.object({
  url: z.string().url().describe('URL to profile'),
  forceRefresh: z.boolean().optional().describe('Force re-profiling even if cached'),
});

const profileResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  profile: siteProfileSchema.describe('Site profile'),
  cached: z.boolean().describe('Whether result came from cache'),
  source: z.enum(['pattern-store', 'profiler-cache', 'fresh']).describe('Data source'),
});

const getPatternResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  pattern: storedPatternSchema.optional().describe('Stored pattern (null if not found)'),
});

const listPatternsQuerySchema = z.object({
  siteType: z.enum(['static', 'spa', 'hybrid', 'unknown']).optional(),
  framework: z.string().optional(),
  minConfidence: z.number().min(0).max(100).optional(),
  limit: z.number().min(1).max(100).default(50).optional(),
  offset: z.number().min(0).default(0).optional(),
});

const listPatternsResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  patterns: z.array(storedPatternSchema).describe('List of patterns'),
  total: z.number().describe('Total number of patterns'),
});

const deletePatternResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  deleted: z.boolean().describe('Whether pattern was deleted'),
});

const statsResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  stats: z
    .object({
      totalPatterns: z.number().describe('Total number of patterns'),
      patternsByType: z.record(z.number()).describe('Count by site type'),
      patternsByFramework: z.record(z.number()).describe('Count by framework'),
      avgConfidence: z.number().describe('Average confidence score'),
      oldestPattern: z.string().datetime().optional().describe('Oldest pattern date'),
      newestPattern: z.string().datetime().optional().describe('Newest pattern date'),
    })
    .describe('Pattern statistics'),
});

// =============================================================================
// ROUTES
// =============================================================================

/**
 * POST /api/crawler/profile — Profile a URL
 */
openapi.route(
  'post',
  '/profile',
  {
    summary: 'Profile a website',
    description:
      'Analyze a website to determine its type, framework, and crawl characteristics. Results are cached per-tenant.',
    body: profileRequestSchema,
    response: profileResponseSchema,
  },
  async (req, res) => {
    try {
      const tenantId = getCurrentTenantId();
      if (!tenantId) {
        res.status(403).json({ success: false, error: 'Tenant context required' });
        return;
      }

      const { url, forceRefresh } = req.body;
      const domain = new URL(url).hostname.toLowerCase();

      // Check pattern store first (unless forceRefresh)
      if (!forceRefresh) {
        const stored = await patternStore.getPattern(tenantId, domain, { touch: true });
        if (stored) {
          res.json({
            success: true,
            profile: serializeSiteProfile(stored.profile),
            cached: true,
            source: 'pattern-store',
          });
          return;
        }
      }

      // Profile the site
      const profile = await profiler.profile(url);

      // Store in pattern store
      await patternStore.storePattern({
        domain,
        tenantId,
        profile,
      });

      res.json({
        success: true,
        profile: serializeSiteProfile(profile),
        cached: false,
        source: 'fresh',
      });
    } catch (error) {
      log.error('Profile error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to profile site',
      });
    }
  },
);

/**
 * GET /api/crawler/profile/:domain — Get cached profile
 */
openapi.route(
  'get',
  '/profile/:domain',
  {
    summary: 'Get cached profile',
    description: 'Retrieve a cached site profile by domain',
    response: getPatternResponseSchema,
  },
  async (req, res) => {
    try {
      const tenantId = getCurrentTenantId();
      if (!tenantId) {
        res.status(403).json({ success: false, error: 'Tenant context required' });
        return;
      }

      const { domain } = req.params;
      const stored = await patternStore.getPattern(tenantId, domain, { touch: true });

      if (!stored) {
        res.json({ success: true, pattern: undefined });
        return;
      }

      res.json({
        success: true,
        pattern: serializeStoredPattern(stored),
      });
    } catch (error) {
      log.error('Get pattern error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get pattern',
      });
    }
  },
);

/**
 * GET /api/crawler/patterns — List patterns
 */
openapi.route(
  'get',
  '/patterns',
  {
    summary: 'List cached patterns',
    description: 'List all cached site profiles for the current tenant with optional filtering',
    query: listPatternsQuerySchema,
    response: listPatternsResponseSchema,
  },
  async (req, res) => {
    try {
      const tenantId = getCurrentTenantId();
      if (!tenantId) {
        res.status(403).json({ success: false, error: 'Tenant context required' });
        return;
      }

      const { siteType, framework, minConfidence, limit, offset } = req.query;

      const patterns = await patternStore.findPatterns({
        tenantId,
        siteType: siteType as 'static' | 'spa' | 'hybrid' | 'unknown' | undefined,
        framework: framework as string | undefined,
        minConfidence: minConfidence ? Number(minConfidence) : undefined,
        limit: limit ? Number(limit) : 50,
        offset: offset ? Number(offset) : 0,
      });

      res.json({
        success: true,
        patterns: patterns.map(serializeStoredPattern),
        total: patterns.length,
      });
    } catch (error) {
      log.error('List patterns error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list patterns',
      });
    }
  },
);

/**
 * DELETE /api/crawler/profile/:domain — Delete cached profile
 */
openapi.route(
  'delete',
  '/profile/:domain',
  {
    summary: 'Delete cached profile',
    description: 'Remove a cached site profile from storage',
    response: deletePatternResponseSchema,
  },
  async (req, res) => {
    try {
      const tenantId = getCurrentTenantId();
      if (!tenantId) {
        res.status(403).json({ success: false, error: 'Tenant context required' });
        return;
      }

      const { domain } = req.params;
      const deleted = await patternStore.deletePattern(tenantId, domain);

      res.json({
        success: true,
        deleted,
      });
    } catch (error) {
      log.error('Delete pattern error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete pattern',
      });
    }
  },
);

/**
 * GET /api/crawler/stats — Get statistics
 */
openapi.route(
  'get',
  '/stats',
  {
    summary: 'Get pattern statistics',
    description: 'Get aggregated statistics for all cached patterns',
    response: statsResponseSchema,
  },
  async (_req, res) => {
    try {
      const tenantId = getCurrentTenantId();
      if (!tenantId) {
        res.status(403).json({ success: false, error: 'Tenant context required' });
        return;
      }

      const stats = await patternStore.getStats(tenantId);

      res.json({
        success: true,
        stats: {
          totalPatterns: stats.totalPatterns,
          patternsByType: stats.patternsByType,
          patternsByFramework: stats.patternsByFramework,
          avgConfidence: stats.avgConfidence,
          oldestPattern: stats.oldestPattern?.toISOString(),
          newestPattern: stats.newestPattern?.toISOString(),
        },
      });
    } catch (error) {
      log.error('Get stats error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get stats',
      });
    }
  },
);

// =============================================================================
// SERIALIZATION HELPERS
// =============================================================================

function serializeSiteProfile(profile: SiteProfile) {
  return {
    ...profile,
    profiledAt: profile.profiledAt.toISOString(),
  };
}

function serializeStoredPattern(pattern: StoredPattern) {
  return {
    ...pattern,
    profile: serializeSiteProfile(pattern.profile),
    profiledAt: pattern.profiledAt.toISOString(),
    lastAccessedAt: pattern.lastAccessedAt.toISOString(),
    createdAt: pattern.createdAt.toISOString(),
    updatedAt: pattern.updatedAt.toISOString(),
    crawlMetrics: {
      ...pattern.crawlMetrics,
      lastCrawlAt: pattern.crawlMetrics.lastCrawlAt?.toISOString(),
    },
  };
}

export default router;
