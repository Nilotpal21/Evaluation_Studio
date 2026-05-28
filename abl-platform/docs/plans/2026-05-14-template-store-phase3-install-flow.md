# Template Store Phase 3 — Install Flow LLD

**Feature Spec**: `docs/features/template-store.md` (FRs 28-34)
**Test Spec**: `docs/testing/template-store-test-cases.md` (TC-TS-096+)
**HLD**: `docs/specs/template-store.hld.md` (Phase 3 sections)
**Status**: PLANNED
**Date**: 2026-05-14

---

## Overview

Phase 3 delivers the template install flow — the Studio-orchestrated pipeline that creates projects from project templates and merges agent templates into existing projects. The flow leverages the existing `importProjectV2()` pipeline from `@agent-platform/project-io` via the `previewStudioLayeredImportV2()` and `applyStudioLayeredImportV2()` convenience wrappers in `apps/studio/src/lib/project-import/layered-import-support.ts`. Studio fetches the template bundle server-side from the template-store service, converts it to `Map<string, string>`, and feeds it directly to the import pipeline with zero content transformation. The template-store service's Phase 3 role is limited to: (a) serving bundles via the existing `GET /bundle` endpoint and (b) recording install events via a new `POST /install-event` endpoint.

**Functional Requirements covered**: FR-28 (project install), FR-29 (agent install), FR-30 (dry-run preview), FR-31 (provisioning report), FR-32 (auth gating), FR-33 (install count + analytics), FR-34 (adaptive install CTA).

---

## Phase Breakdown

### Phase 0: Prerequisites

**Purpose**: Verify all dependencies are ready before implementation begins.

**Files to Read**:

- `apps/studio/src/lib/project-import/layered-import-support.ts` — Verify `previewStudioLayeredImportV2`, `applyStudioLayeredImportV2`, `loadStudioLayeredImportExistingState`, `createStudioLayeredImportDeps`, `buildLayeredAppliedCounts` signatures
- `apps/studio/src/app/api/projects/[id]/import/preview/route.ts` — Reference pattern for import preview route handler
- `apps/studio/src/app/api/projects/[id]/import/apply/route.ts` — Reference pattern for import apply route handler
- `apps/studio/src/app/api/projects/route.ts` — Reference pattern for project creation (`requireTenantAuth` + `hasPermission('project:create')` + `createProject()`)
- `apps/studio/src/lib/route-handler.ts` — `withRouteHandler` factory (options: `requireProject`, `permissions`, `bodySchema`, `rateLimit`)
- `apps/studio/src/lib/auth.ts` — `requireAuth`, `requireTenantAuth`, `isAuthError`, `AuthenticatedUser` (has `permissions: string[]`)
- `apps/studio/src/lib/permissions.ts` — `StudioPermission.PROJECT_READ`, `StudioPermission.PROJECT_IMPORT`
- `apps/studio/src/lib/permission-resolver.ts` — `hasPermission(permissions: string[], permission: string): boolean`
- `apps/studio/src/lib/api-response.ts` — `successJson`, `errorJson`, `actionJson`, `handleApiError`, `ErrorCode`
- `apps/studio/src/services/project-service.ts` — `createProject(input: CreateProjectInput): Promise<Project>` where `CreateProjectInput = { name, slug?, description?, ownerId, tenantId, channels?, language? }`
- `apps/studio/src/api/project-io.ts` — Client-side import API pattern (`apiFetch`, `handleResponse`)
- `apps/studio/src/proxy.ts` — Template-store proxy at lines 356-363 (rewrites `/api/template-store/*` to `TEMPLATE_STORE_URL/api/v1/*`)
- `apps/studio/src/store/marketplace-store.ts` — Current Zustand store types and actions
- `apps/studio/src/app/marketplace/templates/[slug]/page.tsx` — Detail page with install placeholder at lines 243-248
- `apps/template-store/src/repos/template-repo.ts` — `incrementViewCount` pattern (for modeling `incrementInstallCount`)
- `apps/template-store/src/repos/analytics-repo.ts` — `trackEvent` function and `TrackEventInput` type (currently missing `'install'` in event type union)
- `apps/template-store/src/routes/marketplace.ts` — Existing route patterns, `AuthenticatedRequest` interface
- `apps/template-store/src/middleware/auth.ts` — `requireAuth` middleware for Express (from shared-auth)
- `apps/studio/src/lib/runtime-model-cache-invalidation.ts` — `notifyRuntimeModelConfigChanged` for post-install cache invalidation

**Verification Checks**:

1. `previewStudioLayeredImportV2` accepts `{ files: Map<string, string>, projectId, tenantId, userId, layers?, conflictStrategy?, bindingResolutions? }` — CONFIRMED at line 1833
2. `applyStudioLayeredImportV2` accepts `{ files: Map<string, string>, projectId, tenantId, userId, layers?, conflictStrategy?, previewDigest?, acknowledgedIssueIds?, bindingResolutions? }` — CONFIRMED at line 1870
3. `applyStudioLayeredImportV2` returns `{ success: true, preview, warnings, applied: CoreImportApplyCountsV2, entryAgentName, operationId }` on success — CONFIRMED at line 1973
4. `createProject` returns project with `id`, `name`, `slug` — CONFIRMED at line 147 of project-service.ts
5. Template-store proxy rewrites `/api/template-store/*` to `TEMPLATE_STORE_URL/api/v1/*` — CONFIRMED at line 356 of proxy.ts
6. Bundle endpoint returns `{ success: true, data: { files: Record<string, string> } }` — CONFIRMED at line 227 of marketplace.ts
7. `TrackEventInput.eventType` must be extended to include `'install'` — CONFIRMED at line 18 of analytics-repo.ts

**Exit Criteria**: All verification checks pass. No code changes in this phase.

---

### Phase 1: Template-Store Install Event Endpoint

**Purpose**: Add `POST /api/v1/marketplace/templates/:slug/install-event` to the template-store service. This endpoint atomically increments `Template.installCount` and records an `install` analytics event.

#### Files to Modify

| File                                              | Change                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/template-store/src/repos/analytics-repo.ts` | Extend `TrackEventInput.eventType` union to include `'install'`      |
| `apps/template-store/src/repos/template-repo.ts`  | Add `incrementInstallCount(slug: string): Promise<boolean>` function |
| `apps/template-store/src/routes/marketplace.ts`   | Add `POST /templates/:slug/install-event` route                      |

#### Detailed Changes

**1.1 `apps/template-store/src/repos/analytics-repo.ts`**

Extend the `TrackEventInput` type:

```typescript
// BEFORE:
export interface TrackEventInput {
  eventType: 'marketplace_view' | 'detail_view' | 'search' | 'category_browse' | 'bundle_access';
  // ...
}

// AFTER:
export interface TrackEventInput {
  eventType:
    | 'marketplace_view'
    | 'detail_view'
    | 'search'
    | 'category_browse'
    | 'bundle_access'
    | 'install';
  // ... (rest unchanged)
}
```

**1.2 `apps/template-store/src/repos/template-repo.ts`**

Add install count increment function, modeled after the existing `incrementViewCount`:

```typescript
/**
 * Atomically increment installCount on a template found by slug.
 * Returns true if the template was found and updated, false otherwise.
 * Enforces published + public + approved status (same as browse).
 */
export async function incrementInstallCount(slug: string): Promise<boolean> {
  const { Template } = await import('@agent-platform/database/models');

  const result = await Template.updateOne(
    { slug, ...BASE_FILTER },
    { $inc: { installCount: 1 } },
  ).exec();

  log.debug('incrementInstallCount', { slug, matched: result.matchedCount });
  return result.matchedCount > 0;
}
```

**1.3 `apps/template-store/src/routes/marketplace.ts`**

Add install-event route. This route requires authentication (the Studio install route calls it server-side with the user's JWT forwarded through the proxy). Route must be placed BEFORE the `/:slug` GET route to avoid Express match ordering issues.

```typescript
import { requireAuth } from '../middleware/auth.js';

// Zod schema for install event body
const InstallEventBodySchema = z.object({
  userId: z.string().min(1),
  tenantId: z.string().min(1),
  projectId: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
});

/**
 * POST /templates/:slug/install-event — Record a successful template install
 * Auth: requireAuth (JWT) — called server-side by Studio install routes
 */
router.post('/templates/:slug/install-event', requireAuth, async (req: Request, res: Response) => {
  try {
    const slugParse = SlugParamSchema.safeParse(req.params);
    if (!slugParse.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid slug format' },
      });
      return;
    }

    const bodyParse = InstallEventBodySchema.safeParse(req.body);
    if (!bodyParse.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request body' },
      });
      return;
    }

    const { slug } = slugParse.data;
    const { userId, tenantId, projectId, version } = bodyParse.data;

    // Atomically increment installCount
    const updated = await incrementInstallCount(slug);
    if (!updated) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Template not found' },
      });
      return;
    }

    // Fire-and-forget: record install analytics event
    trackEvent({
      eventType: 'install',
      templateSlug: slug,
      userId,
      tenantId,
      metadata: { projectId, version },
    }).catch((err: unknown) => {
      log.error('Install analytics tracking failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    res.json({ success: true });
  } catch (err) {
    log.error('Install event recording failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to record install event' },
    });
  }
});
```

**Route ordering**: The `POST /templates/:slug/install-event` route uses a different HTTP method than the existing `GET /templates/:slug` route, so Express will not confuse them. However, it MUST be placed before any catch-all parameterized routes. Currently the bundle route `GET /templates/:slug/versions/:version/bundle` is correctly placed before `GET /templates/:slug`. The new POST route can be placed anywhere in the router since POST and GET don't conflict.

#### Exit Criteria

- [ ] `POST /api/v1/marketplace/templates/:slug/install-event` with valid JWT + body returns `{ success: true }`
- [ ] Template `installCount` incremented by 1 in MongoDB
- [ ] `template_analytics_events` collection has a new `install` event document
- [ ] Missing auth returns 401, invalid slug returns 400, unknown slug returns 404
- [ ] `pnpm build --filter=template-store` passes

---

### Phase 2: Studio Install API Routes

**Purpose**: Create three new Studio API routes that orchestrate the install flow: project install, agent preview, and agent apply. These routes fetch the bundle server-side, delegate to the existing import pipeline, and notify the template-store on success.

#### Files to Create

| File                                                                   | Purpose                                                                     |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `apps/studio/src/lib/template-install.ts`                              | Server-side bundle fetch helper + install-event notification + shared types |
| `apps/studio/src/app/api/template-install/project/route.ts`            | `POST /api/template-install/project` — create project + import              |
| `apps/studio/src/app/api/template-install/agent/[id]/preview/route.ts` | `POST /api/template-install/agent/[id]/preview` — dry-run preview           |
| `apps/studio/src/app/api/template-install/agent/[id]/apply/route.ts`   | `POST /api/template-install/agent/[id]/apply` — apply import                |

#### Detailed Changes

**2.1 `apps/studio/src/lib/template-install.ts`** (NEW FILE)

Server-side helper for template install operations. Contains the bundle fetch function (internal HTTP to template-store), the install-event notification function, and shared validation schemas.

```typescript
/**
 * Template Install Helpers
 *
 * Server-side functions for the template install flow.
 * Bundle fetch uses internal HTTP to the template-store service
 * (NOT through the browser — server-to-server via TEMPLATE_STORE_URL).
 */

import 'server-only';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';
import { AppError, ErrorCodes } from '@agent-platform/shared/errors';

const log = createLogger('template-install');

// ─── Constants ──────────────────────────────────────────────────────────

function getTemplateStoreUrl(): string {
  return process.env.TEMPLATE_STORE_URL || 'http://localhost:3115';
}

// ─── Validation Schemas ─────────────────────────────────────────────────

const SLUG_REGEX = /^[a-z0-9-]+$/;
const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

export const ProjectInstallBodySchema = z.object({
  templateSlug: z.string().min(1).max(100).regex(SLUG_REGEX, 'Invalid template slug format'),
  version: z.string().min(1).max(20).regex(SEMVER_REGEX, 'Invalid version format'),
  projectName: z.string().trim().min(1, 'Project name is required').max(100),
  projectSlug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens')
    .optional(),
  description: z.string().trim().max(500).optional(),
});
export type ProjectInstallBody = z.infer<typeof ProjectInstallBodySchema>;

export const AgentPreviewBodySchema = z.object({
  templateSlug: z.string().min(1).max(100).regex(SLUG_REGEX, 'Invalid template slug format'),
  version: z.string().min(1).max(20).regex(SEMVER_REGEX, 'Invalid version format'),
});
export type AgentPreviewBody = z.infer<typeof AgentPreviewBodySchema>;

export const AgentApplyBodySchema = z.object({
  templateSlug: z.string().min(1).max(100).regex(SLUG_REGEX, 'Invalid template slug format'),
  version: z.string().min(1).max(20).regex(SEMVER_REGEX, 'Invalid version format'),
  previewDigest: z.string().nullable().optional(),
  acknowledgedIssueIds: z.array(z.string()).optional(),
});
export type AgentApplyBody = z.infer<typeof AgentApplyBodySchema>;

// ─── Bundle Fetch ───────────────────────────────────────────────────────

/**
 * Fetch a template bundle from the template-store service (server-side).
 * Uses internal HTTP — NOT through the Studio proxy or browser.
 *
 * @param slug - Template slug
 * @param version - Semver version string
 * @param authorization - Authorization header value from the original request
 *                        (forwarded to template-store for auth)
 * @returns Record<string, string> — the files bundle (relative path → content)
 */
export async function fetchTemplateBundle(
  slug: string,
  version: string,
  authorization: string,
): Promise<Record<string, string>> {
  const baseUrl = getTemplateStoreUrl();
  const url = `${baseUrl}/api/v1/marketplace/templates/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/bundle`;

  log.info('Fetching template bundle', { slug, version, baseUrl });

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Template-store connection failed', { slug, version, error: message });
    throw new AppError('TEMPLATE_STORE_UNAVAILABLE', 'Template store service is unavailable', 502);
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new AppError(
        'TEMPLATE_NOT_FOUND',
        `Template "${slug}" version "${version}" not found`,
        404,
      );
    }
    const body = await response.text().catch(() => '');
    log.error('Bundle fetch failed', { slug, version, status: response.status, body });
    throw new AppError(
      'BUNDLE_FETCH_FAILED',
      `Failed to fetch template bundle (${response.status})`,
      502,
    );
  }

  const data = await response.json();
  const files = data?.data?.files;

  if (!files || typeof files !== 'object') {
    throw new AppError('BUNDLE_INVALID', 'Template bundle response has unexpected format', 502);
  }

  log.info('Template bundle fetched', {
    slug,
    version,
    fileCount: Object.keys(files).length,
  });

  return files as Record<string, string>;
}

// ─── Install Event Notification ─────────────────────────────────────────

/**
 * Notify the template-store service of a successful install.
 * Fire-and-forget — errors are logged but not thrown.
 */
export async function notifyInstallEvent(input: {
  slug: string;
  version: string;
  userId: string;
  tenantId: string;
  projectId: string;
  authorization: string;
}): Promise<void> {
  const baseUrl = getTemplateStoreUrl();
  const url = `${baseUrl}/api/v1/marketplace/templates/${encodeURIComponent(input.slug)}/install-event`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: input.authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: input.userId,
        tenantId: input.tenantId,
        projectId: input.projectId,
        version: input.version,
      }),
    });

    if (!response.ok) {
      log.warn('Install event notification failed', {
        slug: input.slug,
        status: response.status,
      });
    } else {
      log.info('Install event recorded', { slug: input.slug, projectId: input.projectId });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Install event notification error', { slug: input.slug, error: message });
  }
}

// ─── Provisioning Report ────────────────────────────────────────────────

/**
 * Fetch template prerequisites from the template-store detail endpoint
 * and return as the provisioning report.
 * Falls back to empty arrays if the fetch fails.
 */
export async function fetchTemplatePrerequisites(
  slug: string,
  authorization: string,
): Promise<{
  envVars: string[];
  connectors: string[];
  mcpServers: string[];
  authProfiles: string[];
}> {
  const baseUrl = getTemplateStoreUrl();
  const url = `${baseUrl}/api/v1/marketplace/templates/${encodeURIComponent(slug)}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return { envVars: [], connectors: [], mcpServers: [], authProfiles: [] };
    }

    const data = await response.json();
    const prereqs = data?.data?.template?.prerequisites;
    if (!prereqs || typeof prereqs !== 'object') {
      return { envVars: [], connectors: [], mcpServers: [], authProfiles: [] };
    }

    return {
      envVars: Array.isArray(prereqs.envVars) ? prereqs.envVars : [],
      connectors: Array.isArray(prereqs.connectors) ? prereqs.connectors : [],
      mcpServers: Array.isArray(prereqs.mcpServers) ? prereqs.mcpServers : [],
      authProfiles: Array.isArray(prereqs.authProfiles) ? prereqs.authProfiles : [],
    };
  } catch {
    return { envVars: [], connectors: [], mcpServers: [], authProfiles: [] };
  }
}
```

**2.2 `apps/studio/src/app/api/template-install/project/route.ts`** (NEW FILE)

Project template install: creates a new project then imports the full template bundle.

```typescript
/**
 * POST /api/template-install/project
 *
 * Create a new project from a project template.
 * 1. Validates auth (requireTenantAuth + project:create permission)
 * 2. Fetches bundle server-side from template-store
 * 3. Creates new project via createProject()
 * 4. Imports bundle via applyStudioLayeredImportV2 with conflictStrategy: 'replace'
 * 5. Notifies template-store of install event (fire-and-forget)
 * 6. Returns 201 with project info + applied counts + provisioning report
 */

export const maxDuration = 120; // seconds — import can be slow for large bundles
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { hasPermission } from '@/lib/permission-resolver';
import { errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import { createProject } from '@/services/project-service';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import {
  applyStudioLayeredImportV2,
  buildLayeredAppliedCounts,
} from '@/lib/project-import/layered-import-support';
import { notifyRuntimeModelConfigChanged } from '@/lib/runtime-model-cache-invalidation';
import {
  ProjectInstallBodySchema,
  fetchTemplateBundle,
  notifyInstallEvent,
  fetchTemplatePrerequisites,
} from '@/lib/template-install';
import { AppError } from '@agent-platform/shared/errors';

const log = createLogger('template-install-project');

export async function POST(request: Request) {
  // 1. Auth
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  if (!hasPermission(user.permissions ?? [], 'project:create')) {
    return errorJson(
      'Forbidden: missing required permission (project:create)',
      403,
      ErrorCode.FORBIDDEN,
    );
  }

  // 2. Parse + validate body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorJson('Invalid JSON body', 400, ErrorCode.VALIDATION_ERROR);
  }

  const parsed = ProjectInstallBodySchema.safeParse(body);
  if (!parsed.success) {
    return errorJson(
      parsed.error.issues.map((i) => i.message),
      400,
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const { templateSlug, version, projectName, description } = parsed.data;
  const authorization = request.headers.get('authorization') ?? '';

  try {
    // 3. Fetch bundle server-side
    const files = await fetchTemplateBundle(templateSlug, version, authorization);

    // 4. Create project
    const project = await createProject({
      name: projectName,
      slug: projectSlug,
      description,
      ownerId: user.id,
      tenantId: user.tenantId,
    });

    // 5. Import bundle into the new project
    const fileMap = new Map(Object.entries(files));
    const importResult = await applyStudioLayeredImportV2({
      files: fileMap,
      projectId: project.id,
      tenantId: user.tenantId,
      userId: user.id,
      conflictStrategy: 'replace',
      // No layers filter — import all layers from the bundle
    });

    if (!importResult.success) {
      // Import failed — the project was created but empty.
      // Log the error but still return the project info so the user
      // can navigate to it or retry.
      log.error('Template import failed after project creation', {
        projectId: project.id,
        templateSlug,
        error: importResult.error,
        stage: importResult.stage,
      });

      return NextResponse.json(
        {
          success: false,
          error: {
            code: importResult.error?.code ?? 'IMPORT_FAILED',
            message: importResult.error?.message ?? 'Template import failed',
          },
          project: { id: project.id, name: project.name, slug: project.slug },
        },
        { status: 500 },
      );
    }

    // 6. Fetch prerequisites for provisioning report
    const provisioningRequired = await fetchTemplatePrerequisites(templateSlug, authorization);

    // 7. Model cache invalidation (if model policies were changed)
    const applied = importResult.applied;
    if ((applied.modelPoliciesUpserted ?? 0) + (applied.modelPoliciesDeleted ?? 0) > 0) {
      await notifyRuntimeModelConfigChanged({
        tenantId: user.tenantId,
        authorization,
      }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('Model cache invalidation failed', { error: message });
      });
    }

    // 8. Notify template-store of install event (fire-and-forget)
    notifyInstallEvent({
      slug: templateSlug,
      version,
      userId: user.id,
      tenantId: user.tenantId,
      projectId: project.id,
      authorization,
    }).catch(() => {
      /* already logged inside notifyInstallEvent */
    });

    // 9. Audit log (fire-and-forget)
    logAuditEvent({
      userId: user.id,
      tenantId: user.tenantId,
      action: AuditActions.PROJECT_CREATED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        projectId: project.id,
        resourceType: 'project',
        resourceId: project.id,
        name: project.name,
        source: 'template-install',
        templateSlug,
        templateVersion: version,
      },
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Audit log failed', { projectId: project.id, error: message });
    });

    log.info('Project template installed', {
      projectId: project.id,
      templateSlug,
      version,
      created: applied.created,
      toolsCreated: applied.toolsCreated,
    });

    return NextResponse.json(
      {
        success: true,
        project: { id: project.id, name: project.name, slug: project.slug },
        applied,
        entryAgentName: importResult.entryAgentName ?? null,
        provisioningRequired,
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof AppError) {
      return errorJson(err.message, err.statusCode ?? 500, err.code);
    }
    return handleApiError(err, 'TemplateInstall.project');
  }
}
```

**2.3 `apps/studio/src/app/api/template-install/agent/[id]/preview/route.ts`** (NEW FILE)

Agent template install preview: fetches bundle and runs dry-run import.

The `[id]` in the path is the target projectId. This follows the `withRouteHandler` convention where `ctx.params.id` resolves to the `[id]` segment, enabling `requireProject: true` to validate project access.

```typescript
/**
 * POST /api/template-install/agent/[id]/preview
 *
 * Preview an agent template install into an existing project (dry-run).
 * [id] = target projectId.
 * Auth: JWT with PROJECT_READ permission on the target project.
 */

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { previewStudioLayeredImportV2 } from '@/lib/project-import/layered-import-support';
import { AgentPreviewBodySchema, fetchTemplateBundle } from '@/lib/template-install';

const log = createLogger('template-install-agent-preview');

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.PROJECT_READ,
    rateLimit: { limit: 10, windowMs: 60_000, scope: 'tenant' },
  },
  async (ctx) => {
    const { tenantId, user, request } = ctx;
    const projectId = ctx.params.id;

    // Parse body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } },
        { status: 400 },
      );
    }

    const parsed = AgentPreviewBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues.map((i) => i.message).join('; '),
          },
        },
        { status: 400 },
      );
    }

    const { templateSlug, version } = parsed.data;
    const authorization = request.headers.get('authorization') ?? '';

    try {
      // Fetch bundle server-side
      const files = await fetchTemplateBundle(templateSlug, version, authorization);
      const fileMap = new Map(Object.entries(files));

      // Run dry-run preview with merge strategy, core layer only
      const result = await previewStudioLayeredImportV2({
        files: fileMap,
        projectId,
        tenantId,
        userId: user.id,
        conflictStrategy: 'merge',
        layers: ['core'],
      });

      if (!result.success) {
        return NextResponse.json(
          {
            success: false,
            preview: result.preview,
            warnings: result.warnings,
            error: result.error,
          },
          { status: 400 },
        );
      }

      return NextResponse.json({
        success: true,
        preview: result.preview,
        previewDigest: result.preview?.previewDigest ?? null,
        warnings: result.warnings,
      });
    } catch (err) {
      if (err && typeof err === 'object' && 'statusCode' in err) {
        const appErr = err as { code: string; message: string; statusCode: number };
        return NextResponse.json(
          { success: false, error: { code: appErr.code, message: appErr.message } },
          { status: appErr.statusCode },
        );
      }

      log.error('Agent template preview failed', {
        projectId,
        templateSlug,
        error: err instanceof Error ? err.message : String(err),
      });

      return NextResponse.json(
        { success: false, error: { code: 'INTERNAL_ERROR', message: 'Preview failed' } },
        { status: 500 },
      );
    }
  },
);
```

**2.4 `apps/studio/src/app/api/template-install/agent/[id]/apply/route.ts`** (NEW FILE)

Agent template install apply: fetches bundle, applies import, notifies install event.

```typescript
/**
 * POST /api/template-install/agent/[id]/apply
 *
 * Apply an agent template install into an existing project.
 * [id] = target projectId.
 * Auth: JWT with PROJECT_IMPORT permission on the target project.
 */

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { applyStudioLayeredImportV2 } from '@/lib/project-import/layered-import-support';
import { notifyRuntimeModelConfigChanged } from '@/lib/runtime-model-cache-invalidation';
import {
  AgentApplyBodySchema,
  fetchTemplateBundle,
  notifyInstallEvent,
  fetchTemplatePrerequisites,
} from '@/lib/template-install';

const log = createLogger('template-install-agent-apply');

function hasModelPolicyMutations(applied: {
  modelPoliciesUpserted?: number;
  modelPoliciesDeleted?: number;
}): boolean {
  return (applied.modelPoliciesUpserted ?? 0) + (applied.modelPoliciesDeleted ?? 0) > 0;
}

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.PROJECT_IMPORT,
    rateLimit: { limit: 5, windowMs: 60_000, scope: 'tenant' },
  },
  async (ctx) => {
    const { tenantId, user, request } = ctx;
    const projectId = ctx.params.id;

    // Parse body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } },
        { status: 400 },
      );
    }

    const parsed = AgentApplyBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues.map((i) => i.message).join('; '),
          },
        },
        { status: 400 },
      );
    }

    const { templateSlug, version, previewDigest, acknowledgedIssueIds } = parsed.data;
    const authorization = request.headers.get('authorization') ?? '';

    try {
      // Fetch bundle server-side (re-fetch to avoid stale data)
      const files = await fetchTemplateBundle(templateSlug, version, authorization);
      const fileMap = new Map(Object.entries(files));

      // Apply import with merge strategy, core layer only
      const result = await applyStudioLayeredImportV2({
        files: fileMap,
        projectId,
        tenantId,
        userId: user.id,
        conflictStrategy: 'merge',
        layers: ['core'],
        previewDigest: previewDigest ?? undefined,
        acknowledgedIssueIds: acknowledgedIssueIds ?? undefined,
      });

      if (!result.success) {
        const error = result.error
          ? { ...result.error, stage: result.stage }
          : { code: 'IMPORT_FAILED', message: 'Agent template import failed' };

        return NextResponse.json(
          {
            success: false,
            error,
            preview: result.preview,
            warnings: result.warnings,
            operationId: result.operationId,
          },
          { status: result.stage === 'apply' ? 500 : 400 },
        );
      }

      // Model cache invalidation
      if (hasModelPolicyMutations(result.applied)) {
        await notifyRuntimeModelConfigChanged({ tenantId, authorization }).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          log.warn('Model cache invalidation failed', { error: message });
        });
      }

      // Fetch prerequisites for provisioning report
      const provisioningRequired = await fetchTemplatePrerequisites(templateSlug, authorization);

      // Notify template-store of install event (fire-and-forget)
      notifyInstallEvent({
        slug: templateSlug,
        version,
        userId: user.id,
        tenantId,
        projectId,
        authorization,
      }).catch(() => {
        /* already logged inside notifyInstallEvent */
      });

      log.info('Agent template installed', {
        projectId,
        templateSlug,
        version,
        created: result.applied.created,
        toolsCreated: result.applied.toolsCreated,
      });

      return NextResponse.json({
        success: true,
        operationId: result.operationId,
        applied: result.applied,
        entryAgentName: result.entryAgentName ?? null,
        warnings: result.warnings,
        provisioningRequired,
      });
    } catch (err) {
      if (err && typeof err === 'object' && 'statusCode' in err) {
        const appErr = err as { code: string; message: string; statusCode: number };
        return NextResponse.json(
          { success: false, error: { code: appErr.code, message: appErr.message } },
          { status: appErr.statusCode },
        );
      }

      log.error('Agent template apply failed', {
        projectId,
        templateSlug,
        error: err instanceof Error ? err.message : String(err),
      });

      return NextResponse.json(
        { success: false, error: { code: 'INTERNAL_ERROR', message: 'Apply failed' } },
        { status: 500 },
      );
    }
  },
);
```

#### Exit Criteria

- [ ] `POST /api/template-install/project` with valid JWT + body creates project, imports bundle, returns 201
- [ ] `POST /api/template-install/agent/[id]/preview` returns dry-run preview with `previewDigest`
- [ ] `POST /api/template-install/agent/[id]/apply` imports bundle with merge strategy, returns applied counts
- [ ] Both apply routes notify template-store install-event endpoint (fire-and-forget)
- [ ] Both apply routes return `provisioningRequired` field
- [ ] Missing auth returns 401, missing permission returns 403, bad template returns 404/502
- [ ] `pnpm build --filter=studio` passes

---

### Phase 3: Studio Client API

**Purpose**: Create client-side API functions for the install flow and extend the marketplace store with install state.

#### Files to Create

| File                                      | Purpose                                    |
| ----------------------------------------- | ------------------------------------------ |
| `apps/studio/src/api/template-install.ts` | Client-side API functions for install flow |

#### Files to Modify

| File                                         | Change                                                             |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `apps/studio/src/store/marketplace-store.ts` | Add install state, install actions, project list for agent install |

#### Detailed Changes

**3.1 `apps/studio/src/api/template-install.ts`** (NEW FILE)

```typescript
/**
 * Template Install API Client
 *
 * Client-side functions for the template install flow.
 * All calls go through apiFetch() which auto-attaches JWT auth headers.
 */

import { apiFetch, handleResponse } from '../lib/api-client';

// ─── Types ──────────────────────────────────────────────────────────────

export interface ProjectInstallRequest {
  templateSlug: string;
  version: string;
  projectName: string;
  description?: string;
}

export interface ProjectInstallResponse {
  success: true;
  project: { id: string; name: string; slug: string };
  applied: {
    created: number;
    updated: number;
    deleted: number;
    toolsCreated: number;
    toolsUpdated: number;
    toolsDeleted: number;
    localesCreated: number;
    localesUpdated: number;
    localesDeleted: number;
    profilesCreated: number;
    profilesUpdated: number;
    profilesDeleted: number;
    evalsCreated: number;
    evalsUpdated: number;
    evalsDeleted: number;
    modelPoliciesUpserted: number;
    modelPoliciesDeleted: number;
  };
  entryAgentName: string | null;
  provisioningRequired: {
    envVars: string[];
    connectors: string[];
    mcpServers: string[];
    authProfiles: string[];
  };
}

export interface AgentPreviewRequest {
  templateSlug: string;
  version: string;
}

export interface AgentPreviewResponse {
  success: true;
  preview: {
    layers: string[];
    agentChanges: {
      added: string[];
      modified: Array<{ name: string; changes: string[] }>;
      removed: string[];
      unchanged: string[];
    };
    toolChanges: {
      added: string[];
      modified: string[];
      removed: string[];
    };
    issues: Array<{ id: string; severity: string; message: string }>;
    hasBlockingIssues: boolean;
    previewDigest: string;
    entryAgentResolution: { resolved: string | null };
  };
  previewDigest: string | null;
  warnings: string[];
}

export interface AgentApplyRequest {
  templateSlug: string;
  version: string;
  previewDigest?: string | null;
  acknowledgedIssueIds?: string[];
}

export interface AgentApplyResponse {
  success: true;
  operationId: string;
  applied: ProjectInstallResponse['applied'];
  entryAgentName: string | null;
  warnings: string[];
  provisioningRequired: {
    envVars: string[];
    connectors: string[];
    mcpServers: string[];
    authProfiles: string[];
  };
}

export interface InstallErrorResponse {
  success: false;
  error: { code: string; message: string };
  project?: { id: string; name: string; slug: string };
}

// ─── API Functions ──────────────────────────────────────────────────────

/**
 * Install a project template — creates a new project and imports the bundle.
 */
export async function installProjectTemplate(
  input: ProjectInstallRequest,
): Promise<ProjectInstallResponse> {
  const response = await apiFetch('/api/template-install/project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
    throw new Error(
      body?.error?.message ?? body?.errors?.[0]?.msg ?? `Install failed (${response.status})`,
    );
  }

  return response.json();
}

/**
 * Preview an agent template install — dry-run into an existing project.
 */
export async function previewAgentInstall(
  projectId: string,
  input: AgentPreviewRequest,
): Promise<AgentPreviewResponse> {
  const response = await apiFetch(
    `/api/template-install/agent/${encodeURIComponent(projectId)}/preview`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
    throw new Error(
      body?.error?.message ?? body?.errors?.[0]?.msg ?? `Preview failed (${response.status})`,
    );
  }

  return response.json();
}

/**
 * Apply an agent template install — merge into an existing project.
 */
export async function applyAgentInstall(
  projectId: string,
  input: AgentApplyRequest,
): Promise<AgentApplyResponse> {
  const response = await apiFetch(
    `/api/template-install/agent/${encodeURIComponent(projectId)}/apply`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
    throw new Error(
      body?.error?.message ?? body?.errors?.[0]?.msg ?? `Apply failed (${response.status})`,
    );
  }

  return response.json();
}
```

**3.2 `apps/studio/src/store/marketplace-store.ts`** (MODIFY)

Extend the store with install state and actions. Add to the `MarketplaceState` interface and the `create()` initializer.

New state fields:

```typescript
// Install state
installLoading: boolean;
installError: string | null;
installResult: {
  project?: { id: string; name: string; slug: string };
  applied?: Record<string, number>;
  entryAgentName?: string | null;
  provisioningRequired?: {
    envVars: string[];
    connectors: string[];
    mcpServers: string[];
    authProfiles: string[];
  };
} | null;

// Agent install flow state
agentPreview: {
  preview: Record<string, unknown>;
  previewDigest: string | null;
  warnings: string[];
} | null;
agentPreviewLoading: boolean;
agentPreviewError: string | null;

// User's projects (for agent install project selector)
userProjects: Array<{ id: string; name: string; slug: string; agentCount: number }>;
userProjectsLoading: boolean;
```

New actions:

```typescript
installProjectTemplate: (input: {
  templateSlug: string;
  version: string;
  projectName: string;
  description?: string;
}) => Promise<void>;

previewAgentInstall: (projectId: string, templateSlug: string, version: string) => Promise<void>;

applyAgentInstall: (
  projectId: string,
  templateSlug: string,
  version: string,
  previewDigest?: string | null,
) => Promise<void>;

fetchUserProjects: () => Promise<void>;
resetInstallState: () => void;
```

Each action delegates to the corresponding function in `api/template-install.ts`, manages loading/error state, and stores the result.

#### Exit Criteria

- [ ] Client API functions type-check and build
- [ ] Marketplace store has install state and actions
- [ ] `pnpm build --filter=studio` passes

---

### Phase 4: Install UI Components

**Purpose**: Create the UI components for the install flow: adaptive install button, project install dialog, agent project selector, agent preview dialog, and post-install checklist.

#### Files to Create

| File                                                                     | Purpose                                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `apps/studio/src/components/marketplace/InstallButton.tsx`               | Adaptive CTA: "Create Project" for project templates, "Add to Project" for agent templates |
| `apps/studio/src/components/marketplace/ProjectInstallDialog.tsx`        | Modal dialog for project template install (name input → loading → result)                  |
| `apps/studio/src/components/marketplace/AgentInstallProjectSelector.tsx` | Dropdown to select target project for agent template install                               |
| `apps/studio/src/components/marketplace/AgentInstallPreviewDialog.tsx`   | Modal showing dry-run preview with confirm/cancel                                          |
| `apps/studio/src/components/marketplace/PostInstallChecklist.tsx`        | Provisioning requirements display after successful install                                 |

#### Files to Modify

| File                                        | Change                        |
| ------------------------------------------- | ----------------------------- |
| `packages/i18n/locales/en/marketplace.json` | Add install-related i18n keys |

#### Component Specifications

**4.1 `InstallButton.tsx`**

Props:

```typescript
interface InstallButtonProps {
  template: MarketplaceTemplate;
  version: MarketplaceTemplateVersion | null;
  onProjectInstall: () => void; // opens ProjectInstallDialog
  onAgentInstall: () => void; // opens AgentInstallProjectSelector
}
```

Behavior:

- If `template.type === 'project'`: renders a primary button with text `t('install.createProject')` and icon `FolderPlus` from lucide-react. On click: calls `onProjectInstall`.
- If `template.type === 'agent'`: renders a primary button with text `t('install.addToProject')` and icon `Plus` from lucide-react. On click: calls `onAgentInstall`.
- Button is disabled when `version` is null (no published version available).
- Uses design-system `Button` component from `@/components/ui/Button`.

**4.2 `ProjectInstallDialog.tsx`**

Props:

```typescript
interface ProjectInstallDialogProps {
  open: boolean;
  onClose: () => void;
  template: MarketplaceTemplate;
  version: MarketplaceTemplateVersion;
  onInstallComplete: (projectId: string) => void;
}
```

States: `idle` → `loading` → `success` | `error`

Content:

- **Idle**: Form with project name input (pre-filled with template name), optional description textarea. Submit button: `t('install.createAndInstall')`.
- **Loading**: Spinner with `t('install.installing')` message. Button disabled.
- **Success**: Checkmark icon, project link, `PostInstallChecklist` component. "Go to Project" button.
- **Error**: Error message with retry button.

On submit: calls `installProjectTemplate()` from the store. On success: calls `onInstallComplete(projectId)`.

**4.3 `AgentInstallProjectSelector.tsx`**

Props:

```typescript
interface AgentInstallProjectSelectorProps {
  open: boolean;
  onClose: () => void;
  onProjectSelected: (projectId: string) => void;
}
```

Content:

- Fetches user's projects via `fetchUserProjects()` store action.
- Renders a searchable dropdown (uses `Select` from `@/components/ui/Select`) of projects.
- Each option shows project name and agent count.
- On selection: calls `onProjectSelected(projectId)`.
- Loading state while projects are fetching.
- Empty state if user has no projects: "Create a project first" message with link.

**4.4 `AgentInstallPreviewDialog.tsx`**

Props:

```typescript
interface AgentInstallPreviewDialogProps {
  open: boolean;
  onClose: () => void;
  template: MarketplaceTemplate;
  version: MarketplaceTemplateVersion;
  projectId: string;
  projectName: string;
  onInstallComplete: () => void;
}
```

States: `loading-preview` → `preview-ready` → `applying` → `success` | `error`

Content:

- **Loading Preview**: Spinner with `t('install.generatingPreview')`.
- **Preview Ready**: Shows what will be added/modified:
  - Agents: added (green), modified (yellow), unchanged (gray)
  - Tools: added (green), modified (yellow)
  - Warnings/issues if any
  - "Install" button + "Cancel" button
  - If `hasBlockingIssues`: install button disabled with explanation
- **Applying**: Spinner with `t('install.applying')`.
- **Success**: `PostInstallChecklist` + "Done" button.
- **Error**: Error message with retry button.

On mount: calls `previewAgentInstall()`. On confirm: calls `applyAgentInstall()` with `previewDigest`.

**4.5 `PostInstallChecklist.tsx`**

Props:

```typescript
interface PostInstallChecklistProps {
  provisioningRequired: {
    envVars: string[];
    connectors: string[];
    mcpServers: string[];
    authProfiles: string[];
  };
  applied?: {
    created: number;
    toolsCreated: number;
    [key: string]: number;
  };
  entryAgentName?: string | null;
}
```

Content:

- Summary section: "X agents created, Y tools created" based on `applied`.
- If `entryAgentName`: "Entry agent: <name>".
- Provisioning section header: `t('install.provisioningRequired')`.
- For each non-empty prerequisite array, render a categorized list:
  - Environment Variables: chip list with warning icon
  - Connectors: chip list with plug icon
  - MCP Servers: chip list with server icon
  - Auth Profiles: chip list with key icon
- If all arrays empty: `t('install.noProvisioning')` with checkmark.

**4.6 i18n keys** (`packages/i18n/locales/en/marketplace.json`)

Add under a new `"install"` section:

```json
{
  "install": {
    "createProject": "Create Project from Template",
    "addToProject": "Add to Project",
    "createAndInstall": "Create & Install",
    "installing": "Installing template...",
    "generatingPreview": "Generating preview...",
    "applying": "Applying template...",
    "installComplete": "Template installed successfully",
    "goToProject": "Go to Project",
    "selectProject": "Select a target project",
    "noProjects": "No projects found. Create a project first.",
    "previewTitle": "Install Preview",
    "previewDescription": "Review what will be added to your project",
    "agentsToAdd": "{count} agent(s) will be added",
    "agentsToModify": "{count} agent(s) will be modified",
    "toolsToAdd": "{count} tool(s) will be added",
    "toolsToModify": "{count} tool(s) will be modified",
    "noChanges": "No changes detected",
    "blockingIssues": "Cannot install: blocking issues detected",
    "confirm": "Install",
    "cancel": "Cancel",
    "retry": "Retry",
    "done": "Done",
    "provisioningRequired": "Post-install setup required",
    "noProvisioning": "No additional setup required — ready to use",
    "provisioningEnvVars": "Environment Variables",
    "provisioningConnectors": "Connectors",
    "provisioningMcpServers": "MCP Servers",
    "provisioningAuthProfiles": "Auth Profiles",
    "installSummary": "{agents} agent(s) and {tools} tool(s) created",
    "entryAgent": "Entry Agent: {name}",
    "installFailed": "Installation failed",
    "installFailedDescription": "An error occurred during installation. Your project may have been partially created.",
    "projectCreated": "Project \"{name}\" created"
  }
}
```

#### Exit Criteria

- [ ] All 5 components render correctly with proper design-system tokens
- [ ] Components use `useTranslation('marketplace')` for all user-facing strings
- [ ] No hardcoded Tailwind palette classes (semantic tokens only)
- [ ] `pnpm build --filter=studio` passes
- [ ] `pnpm build --filter=i18n` passes

---

### Phase 5: Detail Page Integration

**Purpose**: Replace the install placeholder on the template detail page with the real InstallButton, wire up the install dialogs, and add post-install navigation.

#### Files to Modify

| File                                                        | Change                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| `apps/studio/src/app/marketplace/templates/[slug]/page.tsx` | Replace placeholder with `InstallButton`, wire dialogs, add navigation |

#### Detailed Changes

**5.1 Detail Page Modifications**

Replace lines 243-248 (the install placeholder) with:

```tsx
// State for install dialogs
const [showProjectInstall, setShowProjectInstall] = useState(false);
const [showProjectSelector, setShowProjectSelector] = useState(false);
const [showAgentPreview, setShowAgentPreview] = useState(false);
const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
const [selectedProjectName, setSelectedProjectName] = useState('');

// Navigation after install
const handleProjectInstallComplete = (projectId: string) => {
  setShowProjectInstall(false);
  // Navigate to the new project's agent list
  window.location.href = `/projects/${projectId}/agents`;
};

const handleAgentProjectSelected = (projectId: string) => {
  setSelectedProjectId(projectId);
  setShowProjectSelector(false);
  setShowAgentPreview(true);
};

const handleAgentInstallComplete = () => {
  setShowAgentPreview(false);
  // Stay on marketplace or navigate — user decides via PostInstallChecklist
};
```

In the sidebar, replace the placeholder div:

```tsx
{
  /* Install CTA */
}
<div className="rounded-xl border border-default bg-background-elevated p-4">
  <InstallButton
    template={template}
    version={version}
    onProjectInstall={() => setShowProjectInstall(true)}
    onAgentInstall={() => setShowProjectSelector(true)}
  />
</div>;
```

After the page content, add dialog components:

```tsx
{
  /* Install Dialogs */
}
{
  showProjectInstall && version && (
    <ProjectInstallDialog
      open={showProjectInstall}
      onClose={() => setShowProjectInstall(false)}
      template={template}
      version={version}
      onInstallComplete={handleProjectInstallComplete}
    />
  );
}

{
  showProjectSelector && (
    <AgentInstallProjectSelector
      open={showProjectSelector}
      onClose={() => setShowProjectSelector(false)}
      onProjectSelected={handleAgentProjectSelected}
    />
  );
}

{
  showAgentPreview && selectedProjectId && version && (
    <AgentInstallPreviewDialog
      open={showAgentPreview}
      onClose={() => setShowAgentPreview(false)}
      template={template}
      version={version}
      projectId={selectedProjectId}
      projectName={selectedProjectName}
      onInstallComplete={handleAgentInstallComplete}
    />
  );
}
```

#### Exit Criteria

- [ ] Project template detail page shows "Create Project from Template" button
- [ ] Clicking button opens project name dialog, submitting creates project and navigates to it
- [ ] Agent template detail page shows "Add to Project" button
- [ ] Clicking button opens project selector, then preview, then confirm → install completes
- [ ] Post-install checklist shows provisioning requirements
- [ ] Install placeholder text (`installComingSoon`) is no longer visible
- [ ] `pnpm build --filter=studio` passes

---

### Phase 6: Tests

**Purpose**: Add integration tests for install routes, unit tests for UI components, and E2E tests for the install flow.

#### Files to Create

| File                                                                             | Type        | Coverage                                                           |
| -------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| `apps/template-store/src/__tests__/routes/install-event.test.ts`                 | integration | Install event endpoint (TC-TS-101, TC-TS-102, TC-TS-103)           |
| `apps/studio/src/__tests__/api/template-install.test.ts`                         | integration | Studio install routes (TC-TS-096, TC-TS-097, TC-TS-098, TC-TS-099) |
| `apps/studio/src/__tests__/components/marketplace/InstallButton.test.tsx`        | unit        | InstallButton rendering for project vs agent types                 |
| `apps/studio/src/__tests__/components/marketplace/PostInstallChecklist.test.tsx` | unit        | PostInstallChecklist with various prerequisites                    |
| `apps/studio/e2e/marketplace-install.spec.ts`                                    | e2e         | Full install flow (TC-TS-096 through TC-TS-112)                    |

#### Test Specifications

**6.1 Integration: Install Event Endpoint** (`install-event.test.ts`)

- POST with valid JWT + body → 200, installCount incremented, analytics event created
- POST without auth → 401
- POST with invalid slug → 400
- POST with unknown slug → 404
- POST with missing body fields → 400
- Concurrent installs → installCount correctly incremented (atomicity)

**6.2 Integration: Studio Install Routes** (`template-install.test.ts`)

These tests exercise the route handlers with mocked dependencies (bundle fetch, createProject, import pipeline). Per CLAUDE.md test rules, only external third-party packages may be mocked via DI — internal platform modules must not be `vi.mock`'d. The test strategy is:

- Extract the bundle fetch function and import pipeline calls into injectable parameters
- Test the route handler logic: auth checks, validation, error handling, response shape
- Verify the correct import options are passed (conflictStrategy, layers, etc.)

Tests:

- Project install: valid request → 201 with project + applied + provisioningRequired
- Project install: missing auth → 401
- Project install: missing project:create permission → 403
- Project install: template not found → 404
- Project install: template-store unavailable → 502
- Agent preview: valid request → 200 with preview + previewDigest
- Agent preview: missing PROJECT_READ permission → 403
- Agent apply: valid request → 200 with applied + provisioningRequired
- Agent apply: missing PROJECT_IMPORT permission → 403
- Agent apply: stale previewDigest → 409

**6.3 Unit: UI Components** (`InstallButton.test.tsx`, `PostInstallChecklist.test.tsx`)

- InstallButton renders "Create Project from Template" for project type
- InstallButton renders "Add to Project" for agent type
- InstallButton disabled when version is null
- PostInstallChecklist shows categorized prerequisites
- PostInstallChecklist shows "No additional setup" when all empty
- PostInstallChecklist shows applied counts

**6.4 E2E: Install Flow** (`marketplace-install.spec.ts`)

Requires running services (template-store + Studio). Tests the full user flow:

- Browse to a project template detail page → click install → enter name → confirm → navigates to new project
- Browse to an agent template detail page → click "Add to Project" → select project → review preview → confirm → success

#### Exit Criteria

- [ ] All integration tests pass: `pnpm test --filter=template-store`
- [ ] All unit tests pass: `pnpm test --filter=studio`
- [ ] E2E tests defined (may require running services to execute)
- [ ] No `vi.mock` of `@agent-platform/*` or `@abl/*` modules

---

### Phase 7: Verification

**Purpose**: Full build + test run + manual verification.

#### Steps

1. `pnpm build --filter=template-store --filter=studio --filter=i18n --filter=database`
2. `pnpm test --filter=template-store`
3. `pnpm test --filter=studio`
4. `npx prettier --write` on all changed files
5. Manual verification (if services are running):
   - Browse to a project template detail page, verify install button appears
   - Click "Create Project from Template", enter name, verify project is created
   - Browse to an agent template detail page, verify "Add to Project" button appears
   - Click "Add to Project", select project, verify preview dialog shows changes
   - Confirm install, verify agents/tools added to project
   - Verify installCount incremented in template-store
   - Verify post-install checklist shows correct prerequisites

#### Exit Criteria

- [ ] All builds pass
- [ ] All tests pass
- [ ] All files formatted with prettier
- [ ] Manual smoke test passes (if services available)

---

## File Change Manifest

### New Files (12)

| #   | File                                                                     | Package        | Phase |
| --- | ------------------------------------------------------------------------ | -------------- | ----- |
| 1   | `apps/studio/src/lib/template-install.ts`                                | studio         | 2     |
| 2   | `apps/studio/src/app/api/template-install/project/route.ts`              | studio         | 2     |
| 3   | `apps/studio/src/app/api/template-install/agent/[id]/preview/route.ts`   | studio         | 2     |
| 4   | `apps/studio/src/app/api/template-install/agent/[id]/apply/route.ts`     | studio         | 2     |
| 5   | `apps/studio/src/api/template-install.ts`                                | studio         | 3     |
| 6   | `apps/studio/src/components/marketplace/InstallButton.tsx`               | studio         | 4     |
| 7   | `apps/studio/src/components/marketplace/ProjectInstallDialog.tsx`        | studio         | 4     |
| 8   | `apps/studio/src/components/marketplace/AgentInstallProjectSelector.tsx` | studio         | 4     |
| 9   | `apps/studio/src/components/marketplace/AgentInstallPreviewDialog.tsx`   | studio         | 4     |
| 10  | `apps/studio/src/components/marketplace/PostInstallChecklist.tsx`        | studio         | 4     |
| 11  | `apps/template-store/src/__tests__/routes/install-event.test.ts`         | template-store | 6     |
| 12  | `apps/studio/src/__tests__/api/template-install.test.ts`                 | studio         | 6     |

### Modified Files (6)

| #   | File                                                        | Package        | Phase | Change                                           |
| --- | ----------------------------------------------------------- | -------------- | ----- | ------------------------------------------------ |
| 1   | `apps/template-store/src/repos/analytics-repo.ts`           | template-store | 1     | Add `'install'` to event type union              |
| 2   | `apps/template-store/src/repos/template-repo.ts`            | template-store | 1     | Add `incrementInstallCount` function             |
| 3   | `apps/template-store/src/routes/marketplace.ts`             | template-store | 1     | Add POST install-event route                     |
| 4   | `apps/studio/src/store/marketplace-store.ts`                | studio         | 3     | Add install state + actions                      |
| 5   | `apps/studio/src/app/marketplace/templates/[slug]/page.tsx` | studio         | 5     | Replace placeholder with InstallButton + dialogs |
| 6   | `packages/i18n/locales/en/marketplace.json`                 | i18n           | 4     | Add install i18n keys                            |

**Total**: 18 files across 3 packages (template-store, studio, i18n).

---

## Wiring Table

Every cross-component data flow traced end-to-end.

| Data                           | Producer                              | Consumer                             | Full Path                                                                                                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JWT auth token                 | Auth store (`useAuthStore`)           | Studio install routes                | Auth store → `apiFetch()` auto-attaches `Authorization` header → route handler `requireTenantAuth(request)` / `withRouteHandler` auth chain                                                                                                                                          |
| Template bundle files          | Template-store `GET /bundle` endpoint | Studio install routes                | `fetchTemplateBundle()` → internal HTTP to `TEMPLATE_STORE_URL` → response `data.files` → `new Map(Object.entries(files))` → `previewStudioLayeredImportV2()` / `applyStudioLayeredImportV2()` `input.files`                                                                         |
| Project creation               | `createProject()` in project-service  | Project install route                | `POST /api/template-install/project` handler → `createProject({ name, ownerId, tenantId })` → returns `project.id` → used as `projectId` for import                                                                                                                                  |
| Import result (applied counts) | `applyStudioLayeredImportV2()`        | Install response → UI                | `applyStudioLayeredImportV2()` returns `{ applied: CoreImportApplyCountsV2 }` → route returns in response body → client API `installProjectTemplate()` → store `installResult.applied` → `PostInstallChecklist.applied` prop                                                         |
| Provisioning report            | `fetchTemplatePrerequisites()`        | Install response → UI                | `fetchTemplatePrerequisites(slug, auth)` → internal HTTP to template detail endpoint → `data.template.prerequisites` → route returns as `provisioningRequired` → client API response → store `installResult.provisioningRequired` → `PostInstallChecklist.provisioningRequired` prop |
| Install event notification     | Studio install routes                 | Template-store `POST /install-event` | `notifyInstallEvent({ slug, version, userId, tenantId, projectId })` → internal HTTP POST → template-store route → `incrementInstallCount(slug)` + `trackEvent({ eventType: 'install' })`                                                                                            |
| Preview digest                 | `previewStudioLayeredImportV2()`      | Agent apply route                    | Preview returns `preview.previewDigest` → client stores → sends in apply request body `previewDigest` → `applyStudioLayeredImportV2({ previewDigest })` → `validatePreviewAcknowledgement()`                                                                                         |
| User's project list            | `GET /api/projects`                   | AgentInstallProjectSelector          | `fetchUserProjects()` store action → `apiFetch('/api/projects')` → `projects` array → `userProjects` store state → `AgentInstallProjectSelector` renders options                                                                                                                     |
| Selected project               | AgentInstallProjectSelector           | AgentInstallPreviewDialog            | `onProjectSelected(projectId)` callback → parent state `selectedProjectId` → `AgentInstallPreviewDialog.projectId` prop                                                                                                                                                              |
| Template detail                | Marketplace store `selectedTemplate`  | InstallButton + dialogs              | `useMarketplaceStore().selectedTemplate` → `InstallButton.template` prop → determines CTA text → dialog components receive same template                                                                                                                                             |
| Install CTA click              | InstallButton                         | Parent page state                    | `InstallButton.onProjectInstall()` / `onAgentInstall()` → `setShowProjectInstall(true)` / `setShowProjectSelector(true)` → dialog `open` prop                                                                                                                                        |
| Model cache invalidation       | `applyStudioLayeredImportV2()` result | Runtime service                      | Route checks `applied.modelPoliciesUpserted + modelPoliciesDeleted > 0` → `notifyRuntimeModelConfigChanged({ tenantId, authorization })` → HTTP POST to runtime `/model-resolution-cache/invalidate`                                                                                 |

---

## Risk Mitigations

| Risk                                           | Likelihood | Impact | Mitigation                                                                                                                                                                      |
| ---------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Template-store unavailable during install      | Medium     | High   | `fetchTemplateBundle` throws AppError with 502 status. UI shows clear error with retry. Project is not created until bundle is fetched.                                         |
| Import pipeline failure after project creation | Low        | High   | Project is created but empty. Response includes `project.id` so user can navigate to it. Import errors are logged with full context. The staged importer has built-in rollback. |
| Stale preview digest on agent apply            | Low        | Medium | `validatePreviewAcknowledgement` returns `PREVIEW_STALE` error → 409 response → UI prompts re-preview.                                                                          |
| Concurrent installs of same template           | Low        | Low    | `installCount` uses `$inc` (atomic increment). Analytics events are append-only. No race condition.                                                                             |
| Large template bundle causing slow install     | Medium     | Medium | `maxDuration` set to 120s on install routes. Bundle is max 4MB (validated at seed time). Import pipeline handles staged import for large projects.                              |
| Missing permissions                            | Low        | Medium | Auth checks are first in every route handler. Clear 403 error with permission name.                                                                                             |
| Template-store install-event call fails        | Medium     | Low    | Fire-and-forget with error logging. Does not block the install response. installCount may be stale until next successful call.                                                  |

---

## Acceptance Criteria

### AC-1: Project Template Install (FR-28)

- **Given** a published project template with slug "billing-support" and version "1.0.0"
- **When** an authenticated user with `project:create` permission calls `POST /api/template-install/project` with `{ templateSlug: "billing-support", version: "1.0.0", projectName: "My Billing Project" }`
- **Then** a new project is created, the bundle is imported with `conflictStrategy: 'replace'`, and the response is 201 with `{ success: true, project: { id, name, slug }, applied: {...}, entryAgentName, provisioningRequired }`
- **Verify**: `GET /api/projects` includes the new project. Project has agents/tools from the template.

### AC-2: Agent Template Install Preview (FR-30)

- **Given** a published agent template and an existing target project
- **When** an authenticated user with `PROJECT_READ` permission calls `POST /api/template-install/agent/[projectId]/preview` with `{ templateSlug, version }`
- **Then** a dry-run preview is returned showing agents/tools that will be added or modified, with a `previewDigest` for confirmation
- **Verify**: No data is written to the target project (query agents before and after — unchanged).

### AC-3: Agent Template Install Apply (FR-29)

- **Given** a successful preview with `previewDigest`
- **When** the user calls `POST /api/template-install/agent/[projectId]/apply` with the `previewDigest`
- **Then** the template's agents and tools are merged into the project with `conflictStrategy: 'merge'` and `layers: ['core']`, existing agents are preserved
- **Verify**: `GET /api/projects/[id]/agents` shows both existing and newly installed agents.

### AC-4: Post-Install Report (FR-31)

- **Given** a template with `prerequisites.envVars: ['OPENAI_API_KEY']` and `prerequisites.connectors: ['Salesforce CRM']`
- **When** a successful install completes (project or agent)
- **Then** the response includes `provisioningRequired: { envVars: ['OPENAI_API_KEY'], connectors: ['Salesforce CRM'], mcpServers: [], authProfiles: [] }`

### AC-5: Auth Gating (FR-32)

- **Given** no JWT Bearer token in the request
- **When** any install endpoint is called
- **Then** the response is 401 UNAUTHORIZED
- **Verify**: All three install routes reject unauthenticated requests.

### AC-6: Install Count + Analytics (FR-33)

- **Given** a template with `installCount: 5`
- **When** a successful install completes
- **Then** `installCount` is 6 and a new `install` analytics event exists in `template_analytics_events`
- **Verify**: Query MongoDB directly for both the template `installCount` and the analytics event.

### AC-7: Adaptive Install CTA (FR-34)

- **Given** a project template detail page
- **When** the page renders
- **Then** the install button shows "Create Project from Template"
- **Given** an agent template detail page
- **When** the page renders
- **Then** the install button shows "Add to Project"

### AC-FLOW-1: Full Project Install Flow

- **In the running app**: User browses marketplace → clicks a project template → clicks "Create Project from Template" → enters project name "My Test Project" → clicks "Create & Install" → sees loading spinner → sees success with post-install checklist → clicks "Go to Project" → arrives at project agent list with template's agents visible
- **Verify**: Project exists in sidebar, agents from template are listed.

### AC-FLOW-2: Full Agent Install Flow

- **In the running app**: User browses marketplace → clicks an agent template → clicks "Add to Project" → selects an existing project from dropdown → sees preview of what will be added → clicks "Install" → sees success with post-install checklist → navigates to target project → sees new agent added alongside existing agents
- **Verify**: Existing agents unchanged, new agent from template added.

---

## Commit Strategy

All commits use ticket `ABLP-2` and follow max 40 files / max 3 packages per commit.

| #   | Scope                        | Description                                                                                                                                      | Packages               | Est. Files |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ---------- |
| 1   | template-store install-event | Add `POST /install-event` route, `incrementInstallCount` repo function, extend analytics event type                                              | template-store         | 3          |
| 2   | Studio install API routes    | Add `template-install.ts` helper + 3 route files (project, agent/preview, agent/apply)                                                           | studio                 | 4          |
| 3   | Studio client API + store    | Add `api/template-install.ts` + extend marketplace-store with install state                                                                      | studio                 | 2          |
| 4   | Install UI components + i18n | Add 5 components (InstallButton, ProjectInstallDialog, AgentInstallProjectSelector, AgentInstallPreviewDialog, PostInstallChecklist) + i18n keys | studio, i18n           | 6          |
| 5   | Detail page integration      | Replace install placeholder with real InstallButton + wire dialogs                                                                               | studio                 | 1          |
| 6   | Tests: integration           | Add install-event integration tests + Studio install route tests                                                                                 | template-store, studio | 2          |
| 7   | Tests: unit + E2E            | Add UI component unit tests + E2E install flow spec                                                                                              | studio                 | 3          |
