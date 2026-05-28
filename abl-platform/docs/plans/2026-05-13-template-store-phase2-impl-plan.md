# Template Store Phase 2 — Low-Level Design

**Jira**: ABLP-2
**Feature Spec**: `docs/features/template-store.md`
**Test Spec**: `docs/testing/template-store.md`
**Test Cases**: `docs/testing/template-store-test-cases.md` (TC-TS-059 through TC-TS-095)
**HLD**: `docs/specs/template-store.hld.md`
**Status**: PLANNED
**Date**: 2026-05-13

---

## Overview

Phase 2 upgrades the Template Store data model and APIs so that each TemplateVersion stores a complete import-ready `files` bundle aligned with `ProjectManifestV2` from `packages/project-io`. Templates also gain rich `media[]` (replacing `screenshots[]`), `prerequisites`, and `reviewStatus` fields. Browse APIs are updated with MongoDB projections to exclude the large `files` field, a new bundle endpoint provides the `files` payload for Phase 3 install retrieval, and Studio UI components are updated for media gallery, prerequisites display, and type filter tabs.

All current template data is platform-seeded placeholder content. Migration strategy is **drop and re-seed** — safe because there are zero user-generated templates.

---

## Phase Breakdown

Implementation proceeds in 8 sequential phases. Each phase has explicit exit criteria that must pass before proceeding. Dependencies between phases are strict — later phases import from earlier ones.

```
Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7
prereqs    schema     repo       routes    seed       studio    tests     migrate
```

---

## Phase 0: Prerequisites and Preparation

### What to Verify

Before writing any code, verify the following are true:

1. On the correct branch (`feature/template-store`)
2. `pnpm install` is clean (no lockfile changes needed)
3. `pnpm build --filter=@agent-platform/database` passes
4. `pnpm build --filter=template-store` passes
5. Existing tests pass: `pnpm test --filter=template-store`
6. Existing tests pass: `pnpm test --filter=studio` (marketplace tests only)

### Files to Read Before Starting

These files must be read (not just referenced) to understand the current signatures:

| File                                                                   | Why                                                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/database/src/models/template.model.ts`                       | Current `ITemplate` interface, `ScreenshotSchema`, field names                                                            |
| `packages/database/src/models/template-version.model.ts`               | Current `ITemplateVersion` interface, `manifest` type                                                                     |
| `packages/database/src/models/index.ts`                                | Barrel exports — lines 817-829 (Template Store section)                                                                   |
| `apps/template-store/src/repos/template-repo.ts`                       | Current `findTemplates`, `findBySlug`, `findFeaturedTemplates`, `findCategories`, `findLatestPublishedVersion` signatures |
| `apps/template-store/src/repos/analytics-repo.ts`                      | Current `TrackEventInput` type — needs `bundle_access` event type                                                         |
| `apps/template-store/src/routes/marketplace.ts`                        | Current route handlers, Zod schemas, helper functions                                                                     |
| `apps/template-store/src/server.ts`                                    | Middleware ordering — static assets must go BEFORE API routes                                                             |
| `apps/studio/src/store/marketplace-store.ts`                           | Current `MarketplaceTemplate`, `TemplateScreenshot`, `MarketplaceTemplateVersion` types                                   |
| `apps/studio/src/components/marketplace/TemplateScreenshotGallery.tsx` | Current props interface, rendering logic                                                                                  |
| `packages/project-io/src/types.ts`                                     | `ProjectManifestV2` interface (lines 420-450), `ManifestAgent`, `ManifestTool`, `LayerName`                               |
| `packages/i18n/locales/en/marketplace.json`                            | Current 116 lines of i18n keys                                                                                            |

### Exit Criteria

- All verification steps above pass
- All files above have been read and their current signatures are understood

---

## Phase 1: Schema Migration (Database Models)

### Goal

Update `Template` and `TemplateVersion` Mongoose models to support Phase 2 fields: `media[]`, `prerequisites`, `reviewStatus`, `files`, and typed `manifest`.

### Files to Modify

#### 1. `packages/database/src/models/template.model.ts`

**Remove:**

- `ITemplateScreenshot` interface (lines 14-18)
- `ScreenshotSchema` sub-schema (lines 68-75)
- `screenshots` field from `ITemplate` interface (line 58)
- `screenshots` field from `TemplateSchema` (line 119)

**Add interfaces:**

```typescript
export interface ITemplateMedia {
  type: 'image' | 'video';
  url: string;
  thumbnailUrl?: string; // video poster frame
  caption: string;
  order: number;
}

export interface ITemplatePrerequisites {
  envVars: string[];
  connectors: string[];
  mcpServers: string[];
  authProfiles: string[];
  models: string[];
}
```

**Add sub-schemas:**

```typescript
const MediaSchema = new Schema<ITemplateMedia>(
  {
    type: { type: String, required: true, enum: ['image', 'video'] },
    url: { type: String, required: true },
    thumbnailUrl: { type: String, default: undefined },
    caption: { type: String, required: true },
    order: { type: Number, required: true },
  },
  { _id: false },
);

const PrerequisitesSchema = new Schema<ITemplatePrerequisites>(
  {
    envVars: { type: [String], default: [] },
    connectors: { type: [String], default: [] },
    mcpServers: { type: [String], default: [] },
    authProfiles: { type: [String], default: [] },
    models: { type: [String], default: [] },
  },
  { _id: false },
);
```

**Update `ITemplate` interface:**

```typescript
// REMOVE:
screenshots: ITemplateScreenshot[];

// ADD:
media: ITemplateMedia[];
prerequisites: ITemplatePrerequisites;
reviewStatus: string; // 'approved' | 'pending' | 'rejected'
```

**Update `TemplateSchema` fields:**

```typescript
// REMOVE:
screenshots: { type: [ScreenshotSchema], default: [] },

// ADD:
media: { type: [MediaSchema], default: [] },
prerequisites: {
  type: PrerequisitesSchema,
  default: () => ({
    envVars: [],
    connectors: [],
    mcpServers: [],
    authProfiles: [],
    models: [],
  }),
},
reviewStatus: { type: String, default: 'approved' },
```

**Indexes:** No new indexes needed. Existing `{ type: 1, category: 1, status: 1 }` already supports type filtering. The text index on `{ name: 'text', shortDescription: 'text', tags: 'text' }` is unchanged.

#### 2. `packages/database/src/models/template-version.model.ts`

**Update `ITemplateVersion` interface:**

```typescript
// CHANGE:
manifest: Record<string, unknown>;

// TO:
manifest: Record<string, unknown>; // Typed as ProjectManifestV2 at application layer

// ADD:
files: Record<string, string> | null; // Import-ready bundle, max 4MB
```

Note: We keep `manifest` as `Record<string, unknown>` in the Mongoose interface because Mongoose `Schema.Types.Mixed` doesn't enforce TypeScript generics at the schema level. The `ProjectManifestV2` typing is enforced at the application layer (repo, routes, seed script) through explicit type assertions and Zod validation. This avoids a dependency from `@agent-platform/database` on `packages/project-io`.

**Update `TemplateVersionSchema` fields:**

```typescript
// ADD after customizationSchema:
files: { type: Schema.Types.Mixed, default: null },
```

#### 3. `packages/database/src/models/index.ts`

**Update barrel exports (lines 817-829):**

```typescript
// CHANGE:
export { Template, type ITemplate, type ITemplateScreenshot } from './template.model.js';

// TO:
export {
  Template,
  type ITemplate,
  type ITemplateMedia,
  type ITemplatePrerequisites,
} from './template.model.js';
```

The `ITemplateScreenshot` export is removed (breaking change — acceptable because it was only used in the seed script and Studio store, both of which we update). The new `ITemplateMedia` and `ITemplatePrerequisites` types are exported for consumers.

### Build Verification

```bash
pnpm build --filter=@agent-platform/database
```

### Exit Criteria

- `pnpm build --filter=@agent-platform/database` passes
- TypeScript types `ITemplateMedia`, `ITemplatePrerequisites` visible from `@agent-platform/database/models`
- `ITemplate` interface includes `media`, `prerequisites`, `reviewStatus`
- `ITemplateVersion` interface includes `files`
- `ITemplateScreenshot` export removed from barrel
- No `screenshots` field in `ITemplate` or `TemplateSchema`

---

## Phase 2: Repo Layer Updates

### Goal

Update `template-repo.ts` to add MongoDB projections (excluding `files` from browse queries), type filter support on categories, and a new `findBundleBySlugAndVersion()` method. Update `analytics-repo.ts` to add `bundle_access` event type.

### Files to Modify

#### 1. `apps/template-store/src/repos/template-repo.ts`

**Update `BASE_FILTER`** (line 44):

Add `reviewStatus: 'approved'` to ensure only approved templates appear in all browse, detail, featured, and category queries. This is critical for Phase 2's `reviewStatus` field — templates with `'pending'` or `'rejected'` status must be invisible in all public endpoints.

```typescript
// CHANGE:
const BASE_FILTER = { status: 'published', visibility: 'public' };

// TO:
const BASE_FILTER = { status: 'published', visibility: 'public', reviewStatus: 'approved' };
```

This single change propagates to all query functions that spread `BASE_FILTER`: `findTemplates()`, `findTemplateBySlug()`, `findFeaturedTemplates()`, `findCategories()`, and `findBundleBySlugAndVersion()`. No per-function changes needed for reviewStatus filtering.

**Update `findTemplates()`** (line 52):

Add `.select('-files')` projection to the template query if the repo joins version data. Currently, `findTemplates` queries only the `Template` model (no version join), so `files` is not in the response. However, the version data returned by `findLatestPublishedVersion()` needs projection. The key change: ensure no version data with `files` leaks into browse responses.

Since `findTemplates()` currently only queries the `Template` collection (not joined with versions), no projection change is needed here. The `files` exclusion happens in `findLatestPublishedVersion()`.

**Update `findTemplateBySlug()`** (line 101):

No change needed — this queries only the `Template` collection. The version is loaded separately by `findLatestPublishedVersion()`.

**Update `findFeaturedTemplates()`** (line 115):

No change needed — queries only the `Template` collection.

**Update `findLatestPublishedVersion()`** (line 165):

Add `.select('-files')` to exclude the potentially 4MB `files` field from version responses used in browse/detail:

```typescript
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

  log.debug('findLatestPublishedVersion', {
    templateId,
    found: !!version,
  });

  return version;
}
```

**Update `findCategories()`** (line 136):

Add optional `type` parameter to filter category counts by template type:

```typescript
export async function findCategories(
  type?: 'agent' | 'project',
): Promise<Array<{ name: string; count: number }>> {
  const { Template } = await import('@agent-platform/database/models');

  const matchFilter: Record<string, unknown> = { ...BASE_FILTER };
  if (type) {
    matchFilter.type = type;
  }

  const categories = (await Template.aggregate([
    { $match: matchFilter },
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $project: { _id: 0, name: '$_id', count: 1 } },
    { $sort: { count: -1 } },
  ]).exec()) as Array<{ name: string; count: number }>;

  log.debug('findCategories completed', {
    count: categories.length,
    type,
  });

  return categories;
}
```

**Add `findBundleBySlugAndVersion()`** (new function):

```typescript
/**
 * Find the files bundle for a specific template version.
 * Returns ONLY the files field — used for install-time bundle retrieval.
 * Enforces published + public template status.
 */
export async function findBundleBySlugAndVersion(
  slug: string,
  version: string,
): Promise<{ files: Record<string, string> } | null> {
  const { Template, TemplateVersion } = await import('@agent-platform/database/models');

  // First, find the template by slug (enforce published + public)
  const template = (await Template.findOne({
    slug,
    ...BASE_FILTER,
  })
    .select('_id')
    .lean()
    .exec()) as { _id: string } | null;

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
```

**Update `BrowseQuery` interface:**

The interface already has `type?: 'agent' | 'project'` (line 21), so no change needed. The existing `findTemplates()` already handles the `type` filter (lines 57-59).

#### 2. `apps/template-store/src/repos/analytics-repo.ts`

**Update `TrackEventInput` interface** (line 18):

```typescript
// CHANGE:
eventType:
  | "marketplace_view"
  | "detail_view"
  | "search"
  | "category_browse";

// TO:
eventType:
  | "marketplace_view"
  | "detail_view"
  | "search"
  | "category_browse"
  | "bundle_access";
```

### Build Verification

```bash
pnpm build --filter=template-store
```

### Exit Criteria

- `pnpm build --filter=template-store` passes
- `findLatestPublishedVersion()` uses `.select('-files')`
- `findCategories()` accepts optional `type` parameter
- `findBundleBySlugAndVersion()` exists and returns `{ files }` or `null`
- `TrackEventInput.eventType` union includes `'bundle_access'`
- Detail endpoint version response excludes `files` via `.select('-files')` on `findLatestPublishedVersion()`. Browse and featured endpoints do not include version data, so `files` cannot leak. Bundle endpoint is the only path that returns `files`.
- `BASE_FILTER` includes `reviewStatus: 'approved'` — templates with `'pending'` or `'rejected'` status are excluded from all public endpoints including the bundle endpoint

---

## Phase 3: API Route Updates

### Goal

Add `type` query param to categories, add bundle endpoint, add static file serving, record `bundle_access` analytics. Update the categories handler to pass the `type` parameter.

### Files to Modify

#### 1. `apps/template-store/src/routes/marketplace.ts`

**Add Zod schema for bundle endpoint params** (after `SlugParamSchema`, ~line 48):

```typescript
const BundleParamSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/),
  version: z
    .string()
    .min(1)
    .max(20)
    .regex(/^\d+\.\d+\.\d+$/),
});
```

**Add Zod schema for categories type filter** (after `BundleParamSchema`):

```typescript
const CategoriesQuerySchema = z.object({
  type: z.enum(['agent', 'project']).optional(),
});
```

**Update imports** (line 19-26):

Add `findBundleBySlugAndVersion` to the import from `../repos/template-repo.js`:

```typescript
import {
  findTemplates,
  findTemplateBySlug,
  findFeaturedTemplates,
  findCategories,
  incrementViewCount,
  findLatestPublishedVersion,
  findBundleBySlugAndVersion,
} from '../repos/template-repo.js';
```

**Update categories handler** (line 229):

Change from no-arg to parsing optional `type` query param:

```typescript
router.get('/categories', async (req: Request, res: Response) => {
  try {
    const parsed = CategoriesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid query parameters',
        },
      });
      return;
    }

    const categories = await findCategories(parsed.data.type);

    res.json({
      success: true,
      data: { categories },
    });
  } catch (err) {
    log.error('Categories fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to load categories',
      },
    });
  }
});
```

**Add bundle endpoint** (BEFORE the `/templates/:slug` handler to avoid Express route ordering issues — but since the path is `/templates/:slug/versions/:version/bundle` which is more specific than `/templates/:slug`, Express will correctly match the longer path first regardless of order. Still, place it after `/templates` list and before `/templates/:slug` for clarity):

IMPORTANT: The bundle route MUST be declared BEFORE the `/templates/:slug` catch-all route. Express matches top-down and `:slug` would capture `bundle-test/versions/1.0.0/bundle` as the slug. Insert the bundle handler between the browse handler (`GET /templates`) and the detail handler (`GET /templates/:slug`):

```typescript
/**
 * GET /templates/:slug/versions/:version/bundle — Bundle retrieval for install
 * Returns only the `files` field for the specified template version.
 */
router.get('/templates/:slug/versions/:version/bundle', async (req: Request, res: Response) => {
  try {
    const parsed = BundleParamSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid slug or version format',
        },
      });
      return;
    }

    const { slug, version } = parsed.data;
    const bundle = await findBundleBySlugAndVersion(slug, version);

    if (!bundle) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Template version not found',
        },
      });
      return;
    }

    // Fire-and-forget: record bundle_access analytics event
    const authReq = req as AuthenticatedRequest;
    const bundleSizeBytes = JSON.stringify(bundle.files).length;
    trackEvent({
      eventType: 'bundle_access',
      templateSlug: slug,
      userId: getUserId(authReq),
      tenantId: getTenantId(authReq),
      ipHash: getClientIpHash(req),
      metadata: {
        requestId: res.getHeader('x-request-id'),
        version,
        bundleSizeBytes,
      },
    }).catch((err: unknown) => {
      log.error('Analytics tracking failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    log.info('Bundle retrieved', {
      slug,
      version,
      bundleSizeBytes,
    });

    res.json({
      success: true,
      data: { files: bundle.files },
    });
  } catch (err) {
    log.error('Bundle retrieval failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to retrieve bundle',
      },
    });
  }
});
```

#### 2. `apps/template-store/src/server.ts`

**Add static file serving** (BEFORE the API routes mount, AFTER body parsing, BEFORE the 404 handler):

```typescript
import path from 'node:path';
import { fileURLToPath } from 'node:url';
```

Add the static middleware between the observability middleware and the routes section:

```typescript
// ─── Static Assets ──────────────────────────────────────────────────────
// Serve media assets (images, videos) for template detail pages.
// Mounted BEFORE API routes and rate limiter — no auth or rate limiting on static files.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(
  '/assets/templates',
  express.static(path.join(__dirname, '../public/assets/templates'), {
    maxAge: '1d', // Cache static assets for 1 day
    etag: true,
    lastModified: true,
  }),
);
```

**Create the static assets directory structure:**

```bash
mkdir -p apps/template-store/public/assets/templates
```

Note: The `../public/` path is relative to the compiled `dist/` directory. Since `src/server.ts` compiles to `dist/server.js`, `../public/` resolves to `apps/template-store/public/`. This is the standard pattern for Express static files in TypeScript projects.

**Route ordering in server.ts after changes:**

```
1. helmet (security headers)
2. cors
3. compression
4. express.json (body parsing)
5. requestIdMiddleware
6. observabilityMiddleware
7. healthRouter (no auth, no rate limit)
8. express.static /assets/templates (no auth, no rate limit)  ← NEW
9. /api/v1/marketplace (optionalAuth + rateLimiter + marketplaceRouter)
10. 404 handler
11. errorHandler
```

### Build Verification

```bash
pnpm build --filter=template-store
```

### Exit Criteria

- `pnpm build --filter=template-store` passes
- `GET /api/v1/marketplace/templates/:slug/versions/:version/bundle` route exists
- Bundle endpoint validates slug/version format via Zod
- Bundle endpoint returns `{ success: true, data: { files: {...} } }` for valid requests
- Bundle endpoint returns 404 for nonexistent slug or version
- Categories endpoint accepts `?type=agent` or `?type=project`
- Static file serving mounted at `/assets/templates/` before API routes
- `bundle_access` analytics event fired on bundle retrieval

---

## Phase 4: Seed Script Rewrite

### Goal

Rewrite `seed-templates.ts` to produce 5 templates (reduced from 10) with proper `files` bundles, `ProjectManifestV2` manifests, `media[]`, `prerequisites`, and `reviewStatus`. DSL content uses minimal valid ABL syntax. Full content authoring is a separate task.

### Files to Modify

#### 1. `apps/template-store/src/scripts/seed-templates.ts`

**Complete rewrite.** The new script:

1. Drops all existing templates and template versions (safe — platform-seeded only)
2. Defines 5 templates with Phase 2 fields
3. Generates minimal valid ABL DSL content for each template
4. Builds `ProjectManifestV2` manifests
5. Derives `prerequisites` from manifest metadata
6. Validates bundle sizes (< 4MB) and DSL syntax at seed time
7. Creates media asset placeholder directories

**Template roster (5 templates, reduced from 10):**

| Slug                      | Name                    | Type    | Category             | Complexity | Agents             |
| ------------------------- | ----------------------- | ------- | -------------------- | ---------- | ------------------ |
| `customer-service-agent`  | Customer Service Agent  | agent   | customer-service     | starter    | 1                  |
| `technical-support-agent` | Technical Support Agent | agent   | technical-support    | standard   | 1                  |
| `knowledge-worker-agent`  | Knowledge Worker Agent  | agent   | knowledge-management | starter    | 1                  |
| `customer-support-team`   | Customer Support Team   | project | customer-service     | advanced   | 4 (supervisor + 3) |
| `hr-onboarding`           | HR Onboarding           | project | hr                   | standard   | 4 (supervisor + 3) |

**Seed data structure per template:**

```typescript
interface Phase2SeedTemplate {
  // Template fields
  slug: string;
  name: string;
  shortDescription: string;
  longDescription: string;
  type: 'agent' | 'project';
  typeMetadata: Record<string, unknown>;
  detailSections: string[];
  category: string;
  tags: string[];
  complexity: 'starter' | 'standard' | 'advanced';
  demoConversation: Array<{ role: string; content: string }>;
  media: Array<{
    type: 'image' | 'video';
    url: string;
    thumbnailUrl?: string;
    caption: string;
    order: number;
  }>;
  prerequisites: {
    envVars: string[];
    connectors: string[];
    mcpServers: string[];
    authProfiles: string[];
    models: string[];
  };
  reviewStatus: 'approved';
  featuredOrder: number | null;

  // Version fields
  files: Record<string, string>;
  manifest: Record<string, unknown>; // ProjectManifestV2 shape
}
```

**Minimal valid ABL DSL content:**

Each agent template produces a minimal valid `.agent.abl` file. Example for a single-agent template:

```
AGENT customer-service-agent
  MODEL gpt-4o
  PERSONA
    You are a friendly customer service agent.
```

Each project template produces multiple agent files plus a `project.json`. Example for `customer-support-team`:

```
files: {
  "project.json": JSON.stringify(manifest),
  "agents/supervisor.agent.abl": "AGENT supervisor\n  MODEL gpt-4o\n  PERSONA\n    You are a customer support supervisor that routes requests.",
  "agents/triage.agent.abl": "AGENT triage\n  MODEL gpt-4o\n  PERSONA\n    You triage incoming customer requests.",
  "agents/billing.agent.abl": "AGENT billing\n  MODEL gpt-4o\n  PERSONA\n    You handle billing inquiries.",
  "agents/tech-support.agent.abl": "AGENT tech-support\n  MODEL gpt-4o\n  PERSONA\n    You provide technical support."
}
```

**Manifest structure per template:**

```typescript
const manifest = {
  format_version: '2.0',
  name: template.name,
  slug: template.slug,
  description: template.shortDescription,
  abl_version: '1.0.0',
  exported_at: new Date().toISOString(),
  exported_by: 'platform',
  entry_agent: 'supervisor', // or the single agent name for agent templates
  dsl_format: 'legacy',
  layers_included: ['core'],
  agents: {
    /* ManifestAgent entries */
  },
  tools: {},
  metadata: {
    entity_counts: { agents: agentCount, tools: 0 },
    required_env_vars: ['OPENAI_API_KEY'],
    required_connectors: [],
    required_mcp_servers: [],
    required_auth_profiles: [],
  },
};
```

**Prerequisites derivation logic:**

```typescript
function derivePrerequisites(manifest: Record<string, unknown>) {
  const metadata = manifest.metadata as {
    required_env_vars?: string[];
    required_connectors?: string[];
    required_mcp_servers?: string[];
    required_auth_profiles?: Array<{ name: string }>;
  };

  // Extract model names from agent DSL MODEL declarations
  const models = new Set<string>();
  const agents = manifest.agents as Record<string, { path: string }>;
  for (const agent of Object.values(agents)) {
    // In real content, parse via @abl/core; for placeholder, hardcode
    models.add('gpt-4o');
  }

  return {
    envVars: metadata.required_env_vars ?? [],
    connectors: metadata.required_connectors ?? [],
    mcpServers: metadata.required_mcp_servers ?? [],
    authProfiles: (metadata.required_auth_profiles ?? []).map((p) => p.name),
    models: [...models],
  };
}
```

**Bundle size validation:**

```typescript
const MAX_BUNDLE_SIZE_BYTES = 4 * 1024 * 1024; // 4MB

function validateBundleSize(files: Record<string, string>, slug: string): void {
  const size = JSON.stringify(files).length;
  if (size > MAX_BUNDLE_SIZE_BYTES) {
    throw new Error(`Bundle for ${slug} exceeds 4MB limit: ${(size / 1024 / 1024).toFixed(2)}MB`);
  }
}
```

**DSL validation (deferred for placeholder content):**

For Phase 2 placeholder content, DSL validation via `@abl/core` parse is optional. The placeholder DSL is minimal and hand-verified. When real content is authored (separate task), full `parse()` validation will be added.

```typescript
// Future: validate DSL at seed time
// import { parse } from '@abl/core';
// for (const [path, content] of Object.entries(files)) {
//   if (path.endsWith('.agent.abl')) {
//     const { errors } = parse(content);
//     if (errors.length > 0) {
//       log.warn(`DSL validation warnings for ${slug}/${path}`, { errors });
//     }
//   }
// }
```

**Media asset placeholders:**

For Phase 2, media URLs point to `/assets/templates/<slug>/hero.png`. Actual image files are not created as part of the seed script — they are managed separately. The `media[]` array is populated but URLs may return 404 until real assets are placed in the static directory.

```typescript
media: [
  {
    type: 'image',
    url: `/assets/templates/${slug}/hero.png`,
    caption: 'Template overview',
    order: 1,
  },
];
```

**Seed script main flow:**

```typescript
async function main(): Promise<void> {
  log.info('Starting Phase 2 template seed script');

  // 1. Connect to MongoDB
  const { ensureConnected } = await import('@agent-platform/database/models');
  await ensureConnected();

  const { Template, TemplateVersion } = await import('@agent-platform/database/models');

  // 2. Drop existing seed data
  log.info('Dropping existing templates and versions...');
  await Template.deleteMany({});
  await TemplateVersion.deleteMany({});

  // 3. Seed each template
  for (const seed of PHASE2_SEED_TEMPLATES) {
    // Validate bundle size
    validateBundleSize(seed.files, seed.slug);

    // Create template (upsert by slug)
    const templateData = {
      slug: seed.slug,
      name: seed.name,
      // ...all template fields...
      media: seed.media,
      prerequisites: seed.prerequisites,
      reviewStatus: seed.reviewStatus,
      // ...publisher fields...
    };

    const template = await Template.create(templateData);

    // Create version with files and manifest
    await TemplateVersion.create({
      templateId: template._id,
      version: '1.0.0',
      changelog: 'Initial release — Phase 2 seed data',
      manifest: seed.manifest,
      files: seed.files,
      customizationSchema: null,
      status: 'published',
      publishedAt: new Date(),
      createdBy: 'platform',
    });

    log.info(`Seeded: ${seed.slug}`, {
      type: seed.type,
      fileCount: Object.keys(seed.files).length,
      bundleSize: JSON.stringify(seed.files).length,
    });
  }

  log.info('Seed completed', { total: PHASE2_SEED_TEMPLATES.length });

  // Disconnect
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect();
  process.exit(0);
}
```

### Build Verification

```bash
pnpm build --filter=template-store
```

### Exit Criteria

- `pnpm build --filter=template-store` passes
- Seed script produces 5 templates (not 10)
- Each template has `media[]` array (not `screenshots`)
- Each template has `prerequisites` with all 5 sub-fields
- Each template has `reviewStatus: 'approved'`
- Each TemplateVersion has `files` as `Record<string, string>` with `project.json` key
- Each TemplateVersion has `manifest` with `format_version: '2.0'`
- All bundles are under 4MB
- No `screenshots` field on any template
- `public/assets/templates/` directory exists

---

## Phase 5: Studio UI Updates

### Goal

Update the marketplace Zustand store types, rename/update the screenshot gallery to a media gallery supporting video, create a prerequisites display component, add type filter tabs, and update i18n keys.

### Files to Modify

#### 1. `apps/studio/src/store/marketplace-store.ts`

**Remove:**

```typescript
export interface TemplateScreenshot {
  url: string;
  caption: string;
  order: number;
}
```

**Add:**

```typescript
export interface TemplateMedia {
  type: 'image' | 'video';
  url: string;
  thumbnailUrl?: string;
  caption: string;
  order: number;
}

export interface TemplatePrerequisites {
  envVars: string[];
  connectors: string[];
  mcpServers: string[];
  authProfiles: string[];
  models: string[];
}
```

**Update `MarketplaceTemplate` interface:**

```typescript
// REMOVE:
screenshots: TemplateScreenshot[];

// ADD:
media: TemplateMedia[];
prerequisites: TemplatePrerequisites;
reviewStatus: string;
```

**Update `MarketplaceTemplateVersion` interface:**

```typescript
// ADD (files is NOT included in version responses from browse/detail, but define for bundle retrieval):
// No change needed — the version type doesn't include files since browse/detail exclude it.
// A separate fetchBundle action would return files directly, not through the version type.
```

**No changes needed to the store actions or state.** The existing `setTemplateType` action already works. `fetchTemplates` already passes `type` to the API. `fetchCategories` does NOT currently pass `type` — this needs to be updated:

**Update `fetchCategories` action:**

The categories fetch currently does not pass the type filter. For type-filtered category counts, the store should pass the current `templateType` filter:

```typescript
fetchCategories: async () => {
  try {
    const state = get();
    const params = new URLSearchParams();
    if (state.templateType) params.set('type', state.templateType);

    const url = params.toString()
      ? `/api/template-store/marketplace/categories?${params.toString()}`
      : '/api/template-store/marketplace/categories';

    const res = await apiFetch(url);
    if (!res.ok) return;
    const data = await res.json();
    const payload = data.data ?? data;
    set({ categories: payload.categories ?? [] });
  } catch (err) {
    console.warn(
      '[marketplace] Failed to fetch categories:',
      err instanceof Error ? err.message : String(err),
    );
  }
},
```

#### 2. `apps/studio/src/components/marketplace/TemplateScreenshotGallery.tsx`

**Rename and update** to support both images and video via the `media[]` field.

**Strategy:** Update the existing file in-place (rename is optional — the component can remain as `TemplateScreenshotGallery` internally while accepting `media` props, OR be renamed to `MediaGallery`). Recommended: update in-place to minimize import changes across pages.

**Updated props interface:**

```typescript
import type { TemplateMedia } from '@/store/marketplace-store';

interface TemplateScreenshotGalleryProps {
  media: TemplateMedia[]; // Changed from screenshots: TemplateScreenshot[]
}
```

**Updated rendering logic:**

For `type: 'image'`: render `<img>` (same as current).
For `type: 'video'`: render a video element with poster frame:

```tsx
{
  item.type === 'video' ? (
    <video
      poster={item.thumbnailUrl}
      className="w-full aspect-video object-cover"
      controls={false} // No controls in thumbnail
      muted
      playsInline
    >
      <source src={item.url} type="video/mp4" />
    </video>
  ) : (
    <img src={item.url} alt={item.caption} className="w-full aspect-video object-cover" />
  );
}
```

**Updated lightbox:**

In the lightbox, video items play with controls:

```tsx
{
  sorted[lightboxIndex].type === 'video' ? (
    <video
      src={sorted[lightboxIndex].url}
      poster={sorted[lightboxIndex].thumbnailUrl}
      controls
      autoPlay
      className="w-full rounded-xl"
    >
      <source src={sorted[lightboxIndex].url} type="video/mp4" />
    </video>
  ) : (
    <img
      src={sorted[lightboxIndex].url}
      alt={sorted[lightboxIndex].caption}
      className="w-full rounded-xl"
    />
  );
}
```

**Updated empty state i18n key:**

```typescript
// CHANGE:
t('screenshots.noScreenshots');

// TO:
t('media.noMedia');
```

**Callers to update:** Every page/component that passes `screenshots` prop must change to `media`:

- `apps/studio/src/app/marketplace/templates/[slug]/page.tsx` — change `screenshots={template.screenshots}` to `media={template.media}`

#### 3. `apps/studio/src/components/marketplace/PrerequisitesSection.tsx` (NEW FILE)

**Create** a new component for displaying prerequisites on the template detail page:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import type { TemplatePrerequisites } from '@/store/marketplace-store';

interface PrerequisitesSectionProps {
  prerequisites: TemplatePrerequisites;
}

export function PrerequisitesSection({ prerequisites }: PrerequisitesSectionProps) {
  const t = useTranslations('marketplace');

  const sections = [
    {
      key: 'envVars',
      label: t('prerequisites.envVars'),
      items: prerequisites.envVars,
    },
    {
      key: 'connectors',
      label: t('prerequisites.connectors'),
      items: prerequisites.connectors,
    },
    {
      key: 'models',
      label: t('prerequisites.models'),
      items: prerequisites.models,
    },
    {
      key: 'mcpServers',
      label: t('prerequisites.mcpServers'),
      items: prerequisites.mcpServers,
    },
    {
      key: 'authProfiles',
      label: t('prerequisites.authProfiles'),
      items: prerequisites.authProfiles,
    },
  ];

  const hasAnyPrerequisites = sections.some((s) => s.items.length > 0);

  if (!hasAnyPrerequisites) {
    return <p className="text-sm text-muted">{t('prerequisites.noPrerequisites')}</p>;
  }

  return (
    <div className="space-y-4">
      {sections
        .filter((s) => s.items.length > 0)
        .map((section) => (
          <div key={section.key}>
            <h4 className="text-xs font-medium text-muted mb-2">{section.label}</h4>
            <div className="flex flex-wrap gap-2">
              {section.items.map((item) => (
                <span
                  key={item}
                  className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-medium bg-background-muted text-foreground border border-default"
                >
                  {item}
                </span>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}
```

#### 4. `apps/studio/src/components/marketplace/TypeFilterTabs.tsx` (NEW FILE)

**Create** a type filter tab component:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import clsx from 'clsx';

interface TypeFilterTabsProps {
  selectedType: 'agent' | 'project' | null;
  onTypeChange: (type: 'agent' | 'project' | null) => void;
}

const TABS = [
  { value: null, labelKey: 'filters.allTypes' },
  { value: 'project' as const, labelKey: 'typeFilter.projects' },
  { value: 'agent' as const, labelKey: 'typeFilter.agents' },
] as const;

export function TypeFilterTabs({ selectedType, onTypeChange }: TypeFilterTabsProps) {
  const t = useTranslations('marketplace');

  return (
    <div
      className="inline-flex rounded-lg border border-default bg-background-muted p-0.5"
      role="tablist"
    >
      {TABS.map((tab) => (
        <button
          key={tab.value ?? 'all'}
          role="tab"
          aria-selected={selectedType === tab.value}
          onClick={() => onTypeChange(tab.value)}
          className={clsx(
            'px-3 py-1.5 text-sm font-medium rounded-md transition-default',
            selectedType === tab.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted hover:text-foreground',
          )}
        >
          {t(tab.labelKey as any)}
        </button>
      ))}
    </div>
  );
}
```

**Integration with pages:**

The `TypeFilterTabs` component connects to the marketplace store via:

```tsx
const templateType = useMarketplaceStore((s) => s.templateType);
const setTemplateType = useMarketplaceStore((s) => s.setTemplateType);

<TypeFilterTabs selectedType={templateType} onTypeChange={setTemplateType} />;
```

Place the tabs on:

- `apps/studio/src/app/marketplace/page.tsx` (landing page, above featured section)
- `apps/studio/src/app/marketplace/search/page.tsx` (search results, above results grid)
- `apps/studio/src/app/marketplace/category/[category]/page.tsx` (category browse, above results grid)

#### 5. `apps/studio/src/app/marketplace/templates/[slug]/page.tsx`

**Update** the detail page to:

1. Pass `media` instead of `screenshots` to the gallery component
2. Add `PrerequisitesSection` before the install CTA area
3. Show `reviewStatus` badge (if not 'approved' — future use)

```tsx
// Update import
import { PrerequisitesSection } from '@/components/marketplace/PrerequisitesSection';

// In the detail page JSX, add prerequisites section:
{
  template.prerequisites && (
    <div className="mt-6">
      <h3 className="text-sm font-medium text-foreground mb-3">{t('prerequisites.title')}</h3>
      <PrerequisitesSection prerequisites={template.prerequisites} />
    </div>
  );
}

// Update gallery prop:
// CHANGE: screenshots={template.screenshots}
// TO: media={template.media}
```

#### 6. `packages/i18n/locales/en/marketplace.json`

**Add new keys** for Phase 2 UI elements:

```json
{
  "media": {
    "title": "Media",
    "noMedia": "No media available",
    "playVideo": "Play video",
    "close": "Close"
  },
  "prerequisites": {
    "title": "Prerequisites",
    "noPrerequisites": "No prerequisites — ready to install",
    "envVars": "Required Environment Variables",
    "connectors": "Required Connectors",
    "mcpServers": "Required MCP Servers",
    "authProfiles": "Required Auth Profiles",
    "models": "Required Models"
  },
  "typeFilter": {
    "all": "All",
    "projects": "Projects",
    "agents": "Agents"
  }
}
```

These keys are added to the existing JSON object (merged with the current 116-line file). The `screenshots` keys can be kept for backwards compatibility or removed — recommended to keep them and add `media` keys alongside.

### Build Verification

```bash
pnpm build --filter=studio
```

### Exit Criteria

- `pnpm build --filter=studio` passes
- `MarketplaceTemplate` type includes `media`, `prerequisites`, `reviewStatus` (no `screenshots`)
- `TemplateScreenshotGallery` renders both images and video elements
- `PrerequisitesSection` component exists and renders categorized chip lists
- `TypeFilterTabs` component exists with "All", "Projects", "Agents" tabs
- i18n keys for `media`, `prerequisites`, `typeFilter` namespaces exist
- Detail page includes prerequisites section
- Landing/search/category pages include type filter tabs

---

## Phase 6: Test Updates

### Goal

Update existing tests for schema changes and add new tests per the test spec. Cover integration, unit, and E2E scenarios.

### Files to Modify (Existing)

#### 1. `apps/template-store/src/__tests__/routes/marketplace.test.ts`

**Update `SeedTemplateInput` and `seedTemplate` helper:**

Add `media`, `prerequisites`, `reviewStatus` fields. Remove `screenshots`.

```typescript
interface SeedTemplateInput {
  slug: string;
  name: string;
  type: 'agent' | 'project';
  category: string;
  complexity: 'starter' | 'standard' | 'advanced';
  status?: string;
  visibility?: string;
  tags?: string[];
  featuredOrder?: number | null;
  installCount?: number;
  ratingAverage?: number;
  viewCount?: number;
  // Phase 2:
  media?: Array<{
    type: string;
    url: string;
    thumbnailUrl?: string;
    caption: string;
    order: number;
  }>;
  prerequisites?: {
    envVars: string[];
    connectors: string[];
    mcpServers: string[];
    authProfiles: string[];
    models: string[];
  };
  reviewStatus?: string;
}
```

Update `seedTemplate()` function to pass `media` instead of `screenshots`, add `prerequisites`, `reviewStatus`.

**Add `seedTemplateVersion` helper:**

```typescript
async function seedTemplateVersion(templateId: string, overrides: Record<string, unknown> = {}) {
  const { TemplateVersion } = await import('@agent-platform/database/models');
  const defaults = {
    templateId,
    version: '1.0.0',
    changelog: 'Initial release',
    manifest: {
      format_version: '2.0',
      name: 'test',
      slug: 'test',
      agents: {},
      tools: {},
      metadata: { entity_counts: {}, required_env_vars: [] },
    },
    files: {
      'project.json': '{"format_version":"2.0"}',
      'agents/test.agent.abl': 'AGENT test\n  MODEL gpt-4o',
    },
    customizationSchema: null,
    status: 'published',
    publishedAt: new Date(),
    createdBy: 'platform',
  };
  return TemplateVersion.create({ ...defaults, ...overrides });
}
```

**Add new test suites** (corresponds to INT-8 through INT-17, TC-TS-059 through TC-TS-095):

- **INT-8**: Browse excludes `files` from responses — seed template with version+files, verify browse/detail/featured responses don't contain `files`
- **INT-9**: Bundle endpoint returns files for valid slug/version
- **INT-10**: Bundle endpoint returns 404 for invalid slug/version, 400 for invalid format
- **INT-11**: Detail returns `media` and `prerequisites`
- **INT-12**: Type filter on browse endpoints
- **INT-13**: `reviewStatus` filtering (pending templates excluded from browse)
- **INT-14**: Bundle size validation (tested at seed level, not route level)
- **INT-15**: Static media asset serving
- **INT-16**: Seed script validation (separate test file)
- **INT-17**: Manifest typed as ProjectManifestV2

#### 2. `apps/template-store/src/__tests__/repos/template-repo.test.ts`

**Update `seedTemplate` helper:** Add `media`, `prerequisites`, `reviewStatus`. Remove `screenshots`.

**Add new tests:**

- `findLatestPublishedVersion` excludes `files` from result
- `findCategories` with type parameter filters correctly
- `findBundleBySlugAndVersion` returns `files` for valid slug+version
- `findBundleBySlugAndVersion` returns null for nonexistent slug/version
- `findBundleBySlugAndVersion` returns null for non-published template

#### 3. `apps/studio/src/__tests__/components/marketplace/TemplateScreenshotGallery.test.tsx`

**Update test data:** Change `screenshots` to `media` with `type: 'image'` fields.

**Add video test cases:**

- Renders video items with `<video>` tag and poster frame
- Mixed image+video array renders both types correctly
- Lightbox plays video with controls
- Empty media array shows empty state with updated i18n key

#### 4. `apps/studio/src/__tests__/store/marketplace-store.test.ts`

**Update test data:** Replace `screenshots` with `media`, add `prerequisites`, `reviewStatus` to mock responses.

**Add new tests:**

- `setTemplateType` updates `templateType` and triggers refetch
- `fetchTemplateDetail` populates `media` and `prerequisites` on `selectedTemplate`
- `fetchCategories` passes type parameter when `templateType` is set

#### 5. `apps/studio/src/__tests__/components/marketplace/TemplateCard.test.tsx`

**Minor update:** Ensure mock template data uses `media` instead of `screenshots`.

### Files to Create (New)

#### 6. `apps/studio/src/__tests__/components/marketplace/PrerequisitesSection.test.tsx`

**New test file** covering:

- Renders all 5 prerequisite categories when populated
- Hides empty categories (only shows sections with items)
- Shows "No prerequisites" message when all arrays are empty
- Renders correct labels via i18n
- Renders items as chips/badges

#### 7. `apps/studio/src/__tests__/components/marketplace/TypeFilterTabs.test.tsx`

**New test file** covering:

- Renders three tabs: "All", "Projects", "Agents"
- Active tab has visual distinction (aria-selected)
- Clicking "Projects" calls onTypeChange with `'project'`
- Clicking "Agents" calls onTypeChange with `'agent'`
- Clicking "All" calls onTypeChange with `null`

#### 8. `apps/template-store/src/__tests__/scripts/seed-templates.test.ts`

**New test file** (integration) covering:

- Run seed script against test MongoDB
- Verify all templates have `media` array (not `screenshots`)
- Verify all templates have `prerequisites` with 5 sub-fields
- Verify all templates have `reviewStatus: 'approved'`
- Verify all versions have `files` bundle
- Verify all versions have `manifest.format_version === '2.0'`
- Verify all bundles are under 4MB

#### 9. E2E tests (extend existing)

**`apps/studio/e2e/marketplace-search.spec.ts`** — extend with type filter tab scenarios (E2E-6)
**`apps/studio/e2e/marketplace-detail.spec.ts`** — extend with media gallery and prerequisites scenarios (E2E-7, E2E-8, E2E-9)

### Build and Test Verification

```bash
pnpm build --filter=template-store --filter=studio
pnpm test --filter=template-store
pnpm test --filter=studio -- --grep marketplace
```

### Exit Criteria

- All existing Phase 1 tests pass (no regressions)
- All new Phase 2 integration tests pass (INT-8 through INT-17)
- All new Phase 2 unit tests pass
- New E2E test files exist (may require running services to execute)
- `pnpm test --filter=template-store` — all passing
- `pnpm test --filter=studio` (marketplace tests) — all passing
- Total test count: 95 (58 Phase 1 + 37 Phase 2)

---

## Phase 7: Migration and Verification

### Goal

Run the full drop-and-re-seed migration, verify builds across all affected packages, and run the complete test suite.

### Steps

#### 1. Build all affected packages

```bash
pnpm build --filter=@agent-platform/database
pnpm build --filter=template-store
pnpm build --filter=studio
pnpm build --filter=@agent-platform/i18n
```

#### 2. Run full test suite

```bash
pnpm test --filter=template-store
pnpm test --filter=studio -- --grep marketplace
```

#### 3. Drop and re-seed (local development)

```bash
cd apps/template-store
pnpm tsx src/scripts/seed-templates.ts
```

Verify seed output:

- Logs show 5 templates seeded
- Each template logs `type`, `fileCount`, `bundleSize`
- No errors or warnings

#### 4. Manual verification (optional, for running services)

Start services:

```bash
# Terminal 1: Template Store
cd apps/template-store && pnpm dev

# Terminal 2: Studio
cd apps/studio && pnpm dev
```

Verify via curl:

```bash
# Browse — verify media, prerequisites, reviewStatus present, files absent
curl -s http://localhost:3115/api/v1/marketplace/templates | jq '.data.templates[0] | keys'

# Detail — verify media, prerequisites, no screenshots, no files in version
curl -s http://localhost:3115/api/v1/marketplace/templates/customer-service-agent | jq '.data.template | {media, prerequisites, reviewStatus}'

# Bundle — verify files returned
curl -s http://localhost:3115/api/v1/marketplace/templates/customer-service-agent/versions/1.0.0/bundle | jq '.data.files | keys'

# Categories with type filter
curl -s "http://localhost:3115/api/v1/marketplace/categories?type=agent" | jq '.data.categories'

# Bundle 404
curl -s http://localhost:3115/api/v1/marketplace/templates/nonexistent/versions/1.0.0/bundle | jq

# Static asset (will 404 until real assets are placed)
curl -sI http://localhost:3115/assets/templates/customer-service-agent/hero.png
```

#### 5. Run prettier on all changed files

```bash
npx prettier --write \
  packages/database/src/models/template.model.ts \
  packages/database/src/models/template-version.model.ts \
  packages/database/src/models/index.ts \
  apps/template-store/src/repos/template-repo.ts \
  apps/template-store/src/repos/analytics-repo.ts \
  apps/template-store/src/routes/marketplace.ts \
  apps/template-store/src/server.ts \
  apps/template-store/src/scripts/seed-templates.ts \
  apps/studio/src/store/marketplace-store.ts \
  apps/studio/src/components/marketplace/TemplateScreenshotGallery.tsx \
  apps/studio/src/components/marketplace/PrerequisitesSection.tsx \
  apps/studio/src/components/marketplace/TypeFilterTabs.tsx \
  packages/i18n/locales/en/marketplace.json \
  apps/template-store/src/__tests__/routes/marketplace.test.ts \
  apps/template-store/src/__tests__/repos/template-repo.test.ts \
  apps/studio/src/__tests__/components/marketplace/TemplateScreenshotGallery.test.tsx \
  apps/studio/src/__tests__/components/marketplace/PrerequisitesSection.test.tsx \
  apps/studio/src/__tests__/components/marketplace/TypeFilterTabs.test.tsx \
  apps/studio/src/__tests__/store/marketplace-store.test.ts \
  apps/template-store/src/__tests__/scripts/seed-templates.test.ts
```

### Exit Criteria

- `pnpm build --filter=@agent-platform/database --filter=template-store --filter=studio --filter=@agent-platform/i18n` passes
- `pnpm test --filter=template-store` — all tests pass
- `pnpm test --filter=studio` (marketplace subset) — all tests pass
- Seed script runs without errors against local MongoDB
- curl verification returns expected responses
- All changed files formatted with prettier

---

## File Change Manifest

| #   | File Path                                                                             | Change Type      | Phase | Description                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------- | ---------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `packages/database/src/models/template.model.ts`                                      | Modify           | 1     | Remove `screenshots`/`ScreenshotSchema`/`ITemplateScreenshot`; add `media`/`MediaSchema`/`ITemplateMedia`, `prerequisites`/`PrerequisitesSchema`/`ITemplatePrerequisites`, `reviewStatus` |
| 2   | `packages/database/src/models/template-version.model.ts`                              | Modify           | 1     | Add `files: Schema.Types.Mixed` field to schema and `files: Record<string, string> \| null` to interface                                                                                  |
| 3   | `packages/database/src/models/index.ts`                                               | Modify           | 1     | Replace `ITemplateScreenshot` export with `ITemplateMedia`, `ITemplatePrerequisites`                                                                                                      |
| 4   | `apps/template-store/src/repos/template-repo.ts`                                      | Modify           | 2     | Add `.select('-files')` to `findLatestPublishedVersion`, add `type` param to `findCategories`, add `findBundleBySlugAndVersion()`                                                         |
| 5   | `apps/template-store/src/repos/analytics-repo.ts`                                     | Modify           | 2     | Add `'bundle_access'` to `TrackEventInput.eventType` union                                                                                                                                |
| 6   | `apps/template-store/src/routes/marketplace.ts`                                       | Modify           | 3     | Add `BundleParamSchema`, `CategoriesQuerySchema`, bundle endpoint handler, update categories handler to accept `type` param                                                               |
| 7   | `apps/template-store/src/server.ts`                                                   | Modify           | 3     | Add `express.static` for `/assets/templates/` before API routes, add `path`/`fileURLToPath` imports                                                                                       |
| 8   | `apps/template-store/public/assets/templates/`                                        | Create (dir)     | 3     | Empty directory for static media assets                                                                                                                                                   |
| 9   | `apps/template-store/src/scripts/seed-templates.ts`                                   | Modify (rewrite) | 4     | Complete rewrite — 5 templates with `files` bundles, `ProjectManifestV2` manifests, `media[]`, `prerequisites`, `reviewStatus`                                                            |
| 10  | `apps/studio/src/store/marketplace-store.ts`                                          | Modify           | 5     | Replace `TemplateScreenshot` with `TemplateMedia`, add `TemplatePrerequisites`, update `MarketplaceTemplate` interface, update `fetchCategories` to pass type                             |
| 11  | `apps/studio/src/components/marketplace/TemplateScreenshotGallery.tsx`                | Modify           | 5     | Accept `media` prop instead of `screenshots`, render `<video>` for video type items, update lightbox for video, update i18n keys                                                          |
| 12  | `apps/studio/src/components/marketplace/PrerequisitesSection.tsx`                     | Create           | 5     | New component — renders categorized prerequisite chip lists or "no prerequisites" empty state                                                                                             |
| 13  | `apps/studio/src/components/marketplace/TypeFilterTabs.tsx`                           | Create           | 5     | New component — "All" / "Projects" / "Agents" tab group connected to store                                                                                                                |
| 14  | `apps/studio/src/app/marketplace/templates/[slug]/page.tsx`                           | Modify           | 5     | Pass `media` to gallery, add `PrerequisitesSection`                                                                                                                                       |
| 15  | `apps/studio/src/app/marketplace/page.tsx`                                            | Modify           | 5     | Add `TypeFilterTabs` above featured section                                                                                                                                               |
| 16  | `apps/studio/src/app/marketplace/search/page.tsx`                                     | Modify           | 5     | Add `TypeFilterTabs` above results grid                                                                                                                                                   |
| 17  | `apps/studio/src/app/marketplace/category/[category]/page.tsx`                        | Modify           | 5     | Add `TypeFilterTabs` above results grid                                                                                                                                                   |
| 18  | `packages/i18n/locales/en/marketplace.json`                                           | Modify           | 5     | Add `media`, `prerequisites`, `typeFilter` key groups                                                                                                                                     |
| 19  | `apps/template-store/src/__tests__/routes/marketplace.test.ts`                        | Modify           | 6     | Update seed helpers, add ~30 new test cases for INT-8 through INT-15                                                                                                                      |
| 20  | `apps/template-store/src/__tests__/repos/template-repo.test.ts`                       | Modify           | 6     | Update seed helper, add ~6 new test cases for projection, categories type, bundle query                                                                                                   |
| 21  | `apps/studio/src/__tests__/components/marketplace/TemplateScreenshotGallery.test.tsx` | Modify           | 6     | Update to use `media` prop, add ~7 video test cases                                                                                                                                       |
| 22  | `apps/studio/src/__tests__/components/marketplace/TemplateCard.test.tsx`              | Modify           | 6     | Update mock data from `screenshots` to `media`                                                                                                                                            |
| 23  | `apps/studio/src/__tests__/store/marketplace-store.test.ts`                           | Modify           | 6     | Update mock data, add ~4 tests for type filter and new fields                                                                                                                             |
| 24  | `apps/studio/src/__tests__/components/marketplace/PrerequisitesSection.test.tsx`      | Create           | 6     | New test file — 5 test cases                                                                                                                                                              |
| 25  | `apps/studio/src/__tests__/components/marketplace/TypeFilterTabs.test.tsx`            | Create           | 6     | New test file — 6 test cases                                                                                                                                                              |
| 26  | `apps/template-store/src/__tests__/scripts/seed-templates.test.ts`                    | Create           | 6     | New test file — 7 integration test cases for seed validation                                                                                                                              |
| 27  | `apps/studio/e2e/marketplace-search.spec.ts`                                          | Modify           | 6     | Extend with ~7 type filter tab E2E scenarios                                                                                                                                              |
| 28  | `apps/studio/e2e/marketplace-detail.spec.ts`                                          | Modify           | 6     | Extend with ~10 media gallery + prerequisites E2E scenarios                                                                                                                               |

**Total: 28 files (16 modify, 5 create, 1 create directory, 6 test files)**

---

## Risk Mitigations

| Risk                                                    | Impact | Likelihood | Mitigation                                                                                                                                                                         |
| ------------------------------------------------------- | ------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `screenshots` → `media` breaks existing tests           | High   | High       | Update ALL test files in Phase 6 before running. Batch the rename across all consumers in one pass.                                                                                |
| `ITemplateScreenshot` removal breaks barrel consumers   | Medium | Medium     | Grep for `ITemplateScreenshot` across the codebase to find all consumers before removing. Update all in Phase 1.                                                                   |
| `express.static` path resolution fails in compiled code | Medium | Medium     | Use `fileURLToPath(import.meta.url)` + `path.dirname()` to resolve relative to compiled `dist/`. Test with `pnpm build && node dist/index.js`.                                     |
| Bundle endpoint Express route ordering conflict         | High   | Low        | Declare `/templates/:slug/versions/:version/bundle` BEFORE `/templates/:slug`. Express matches longest specific path first, but order matters for ambiguous overlaps.              |
| Seed script DSL content fails `@abl/core` parse         | Medium | Low        | Phase 2 uses minimal placeholder DSL that is hand-verified. Full DSL validation deferred to content authoring task.                                                                |
| MongoDB document size limit hit                         | Low    | Very Low   | 4MB bundle + ~1KB overhead is well within 16MB limit. `validateBundleSize()` enforces at seed time.                                                                                |
| `fetchCategories` race condition with type filter       | Low    | Low        | `fetchCategories` reads current `templateType` from store state synchronously before the async call. No race with `setTemplateType` because Zustand state updates are synchronous. |
| Pre-existing TS build errors in other packages          | Medium | Medium     | Focus only on template-store and studio packages. Ignore pre-existing upstream errors in `@agent-platform/openapi/nextjs`, observatory, etc. (documented in CLAUDE.md).            |
| i18n key collisions                                     | Low    | Low        | New keys use distinct namespaces (`media`, `prerequisites`, `typeFilter`) that don't conflict with existing keys.                                                                  |

---

## Acceptance Criteria

Phase 2 is complete when ALL of the following are true:

### Schema (Phase 1)

- [ ] `Template` model has `media[]` field (not `screenshots`)
- [ ] `Template` model has `prerequisites` embedded object with 5 sub-fields
- [ ] `Template` model has `reviewStatus` field with default `'approved'`
- [ ] `TemplateVersion` model has `files` field (`Record<string, string> | null`)
- [ ] `ITemplateScreenshot` export removed, `ITemplateMedia` and `ITemplatePrerequisites` exported
- [ ] `pnpm build --filter=@agent-platform/database` passes

### Repo (Phase 2)

- [ ] `findLatestPublishedVersion()` excludes `files` via `.select('-files')`
- [ ] `findCategories()` accepts optional `type` parameter
- [ ] `findBundleBySlugAndVersion()` returns `{ files }` or `null`
- [ ] `TrackEventInput` includes `'bundle_access'` event type
- [ ] `pnpm build --filter=template-store` passes

### API (Phase 3)

- [ ] `GET /templates/:slug/versions/:version/bundle` returns `{ success: true, data: { files } }`
- [ ] Bundle endpoint returns 404 for nonexistent slug or version
- [ ] Bundle endpoint returns 400 for invalid version format
- [ ] Categories endpoint accepts `?type=agent` and `?type=project`
- [ ] Static file serving at `/assets/templates/` works (before API routes, no auth)
- [ ] `bundle_access` analytics event recorded on bundle retrieval

### Seed (Phase 4)

- [ ] 5 templates seeded (reduced from 10)
- [ ] All templates have `media[]`, `prerequisites`, `reviewStatus: 'approved'`
- [ ] All versions have `files` with `project.json` key
- [ ] All versions have `manifest` with `format_version: '2.0'`
- [ ] All bundles under 4MB
- [ ] No `screenshots` field on any template

### Studio UI (Phase 5)

- [ ] `TemplateScreenshotGallery` accepts `media` prop, renders images and video
- [ ] `PrerequisitesSection` component renders categorized chip lists
- [ ] `TypeFilterTabs` component renders "All" / "Projects" / "Agents" tabs
- [ ] Detail page shows prerequisites section
- [ ] Landing, search, and category pages show type filter tabs
- [ ] i18n keys for media, prerequisites, typeFilter added
- [ ] `pnpm build --filter=studio` passes

### Tests (Phase 6)

- [ ] All 58 Phase 1 tests still pass (no regressions)
- [ ] 37 new Phase 2 tests pass
- [ ] Total: 95 test cases passing
- [ ] E2E tests written for type filter tabs and prerequisites

### Overall (Phase 7)

- [ ] Full `pnpm build` passes for affected packages
- [ ] Full `pnpm test` passes for affected packages
- [ ] All changed files formatted with `npx prettier --write`
- [ ] Seed script runs successfully against MongoDB

---

## Commit Strategy

Phase 2 implementation should be committed in focused, additive commits:

| Commit | Scope                                                               | Max Files | Description                                                               |
| ------ | ------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------- |
| 1      | `[ABLP-2] feat(database): template model Phase 2 schema`            | ~3        | Schema changes: media, prerequisites, reviewStatus, files                 |
| 2      | `[ABLP-2] feat(template-store): repo layer Phase 2 updates`         | ~2        | Projection, categories type filter, bundle query, analytics event type    |
| 3      | `[ABLP-2] feat(template-store): bundle endpoint and static serving` | ~2        | Route handler, server.ts static middleware                                |
| 4      | `[ABLP-2] feat(template-store): Phase 2 seed script rewrite`        | ~1        | Complete seed rewrite with files, manifests, media, prerequisites         |
| 5      | `[ABLP-2] feat(studio): marketplace UI Phase 2 updates`             | ~8        | Store types, media gallery, prerequisites section, type filter tabs, i18n |
| 6      | `[ABLP-2] test(template-store): Phase 2 integration tests`          | ~3        | Route tests, repo tests, seed validation tests                            |
| 7      | `[ABLP-2] test(studio): Phase 2 marketplace component tests`        | ~5        | Gallery, prerequisites, type filter, store, card tests                    |

Each commit is max 40 files, max 3 packages, and additive (no deleting existing exports in `feat` commits).
