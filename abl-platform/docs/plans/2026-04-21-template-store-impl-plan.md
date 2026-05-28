# LLD: Template Store

**Feature Spec**: `docs/features/template-store.md`
**HLD**: `docs/specs/template-store.hld.md`
**Test Spec**: `docs/testing/template-store.md`
**Test Cases**: `docs/testing/template-store-test-cases.md`
**Status**: DONE
**Date**: 2026-04-21

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                       | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Alternatives Rejected                                            |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| D-1 | Repos at `apps/template-store/src/repos/` using standalone functions           | Matches runtime/Studio pattern. Only one consumer. Templates are cross-tenant, so TenantScopedRepository N/A                                                                                                                                                                                                                                                                                                                                                                                  | Shared repos in `packages/shared/`, class-based TenantScopedRepo |
| D-2 | Tests in separate Phase 3, not test-first                                      | Feature spec delivery plan separates testing. CLAUDE.md commit discipline favors separate test commits                                                                                                                                                                                                                                                                                                                                                                                        | Test-first per phase                                             |
| D-3 | HLD handoff items 1/4/5 as Phase 0 prerequisite                                | Barrel export blocks all repo code. Dockerfile sync blocks Docker builds. Docker-compose blocks local dev                                                                                                                                                                                                                                                                                                                                                                                     | Inline fixes during Phase 1                                      |
| D-4 | Marketplace as Next.js App Router pages (global, not project-scoped)           | Templates are cross-tenant/cross-project. Matches `/academy` pattern. Own layout, UserMenu entry, `window.location.href` navigation. **Deviation from feature spec/HLD**: FR-12 says "sidebar navigation entry" and HLD says "navigation.ts". Academy precedent uses UserMenu dropdown, not sidebar — following actual codebase pattern. Pages at `apps/studio/src/app/marketplace/` (not `(app)/marketplace/`) matching Academy. Feature spec paths will be corrected during post-impl-sync. | Project-scoped page type, SPA navigation via AppShell            |
| D-5 | Seed script as standalone `pnpm tsx` script, not integrated into seed-mongo.ts | Template store is separate service with own DB connection. Seed data is service-specific                                                                                                                                                                                                                                                                                                                                                                                                      | Register in `packages/database/seed-mongo.ts` SeedRunner         |
| D-6 | Analytics events as server-side effects of GET endpoints                       | No POST tracking endpoint needed in Phase 1. Browse endpoint classifies by query params                                                                                                                                                                                                                                                                                                                                                                                                       | Client-initiated tracking POST                                   |
| D-7 | `optionalAuth` on marketplace routes for analytics enrichment                  | Populates userId/tenantId on analytics events when user is authenticated, but doesn't block unauthenticated                                                                                                                                                                                                                                                                                                                                                                                   | No auth at all, requireAuth                                      |

### Key Interfaces & Types

```typescript
// Browse query params (Zod validated)
interface BrowseQuery {
  page: number; // default 1, min 1
  limit: number; // default 20, min 1, max 100
  type?: 'agent' | 'project';
  category?: string;
  complexity?: 'starter' | 'standard' | 'advanced';
  q?: string; // max 200 chars
  sort: 'popular' | 'rating' | 'newest' | 'updated'; // default 'popular'
}

// Paginated response shape
interface PaginatedResponse<T> {
  success: true;
  data: {
    templates: T[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
  };
}

// Category response
interface CategoryResponse {
  success: true;
  data: {
    categories: Array<{ name: string; count: number }>;
  };
}

// Detail response
interface DetailResponse {
  success: true;
  data: {
    template: ITemplate;
    version: ITemplateVersion | null;
  };
}

// Analytics event creation
interface TrackEventInput {
  eventType: 'marketplace_view' | 'detail_view' | 'search' | 'category_browse';
  templateId?: string;
  templateSlug?: string;
  userId?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>; // include requestId here for traceability: { requestId, ... }
  ipHash?: string;
}
```

### Module Boundaries

| Module                     | Responsibility                                                         | Depends On                        |
| -------------------------- | ---------------------------------------------------------------------- | --------------------------------- |
| `packages/database/models` | Mongoose schemas for Template, TemplateVersion, TemplateAnalyticsEvent | mongoose                          |
| `template-repo.ts`         | Browse queries, filters, pagination, text search, view count           | `@agent-platform/database/models` |
| `analytics-repo.ts`        | Analytics event creation, IP hashing                                   | `@agent-platform/database/models` |
| `marketplace.ts` (routes)  | HTTP endpoint handlers, Zod validation, analytics classification       | template-repo, analytics-repo     |
| `server.ts`                | Express app, middleware chain, route mounting                          | routes, middleware                |
| `seed-templates.ts`        | Seed 8-12 platform templates via upsert                                | `@agent-platform/database/models` |
| `marketplace-store.ts`     | Zustand store for UI state, API fetching                               | Studio `apiFetch`                 |
| Marketplace pages          | React page components                                                  | marketplace-store, UI components  |
| Marketplace components     | TemplateCard, CategoryGrid, SearchBar, etc.                            | i18n, lucide-react, design tokens |

---

## 2. File-Level Change Map

### New Files

| File                                                                   | Purpose                                          | LOC Est |
| ---------------------------------------------------------------------- | ------------------------------------------------ | ------- |
| `apps/template-store/src/repos/template-repo.ts`                       | Browse queries, filters, pagination, text search | ~200    |
| `apps/template-store/src/repos/analytics-repo.ts`                      | Analytics event tracking, IP hashing             | ~60     |
| `apps/template-store/src/routes/marketplace.ts`                        | 4 public GET endpoints                           | ~250    |
| `apps/template-store/src/scripts/seed-templates.ts`                    | Seed 8-12 platform templates                     | ~400    |
| `apps/studio/src/store/marketplace-store.ts`                           | Zustand store for marketplace state              | ~150    |
| `apps/studio/src/components/marketplace/TemplateCard.tsx`              | Template card for grid views                     | ~80     |
| `apps/studio/src/components/marketplace/CategoryGrid.tsx`              | Category cards with icons and counts             | ~70     |
| `apps/studio/src/components/marketplace/TemplateSearchBar.tsx`         | Search input + filter dropdowns                  | ~120    |
| `apps/studio/src/components/marketplace/TemplateScreenshotGallery.tsx` | Lightbox gallery                                 | ~80     |
| `apps/studio/src/components/marketplace/DemoConversation.tsx`          | Sample conversation display                      | ~60     |
| `apps/studio/src/components/marketplace/TemplateConfigPreview.tsx`     | Read-only config preview                         | ~60     |
| `apps/studio/src/app/marketplace/layout.tsx`                           | Thin wrapper delegating to MarketplaceLayout     | ~10     |
| `apps/studio/src/components/marketplace/MarketplaceLayout.tsx`         | Client layout: header, nav, back-to-studio link  | ~60     |
| `apps/studio/src/app/marketplace/page.tsx`                             | Landing page                                     | ~120    |
| `apps/studio/src/app/marketplace/templates/[slug]/page.tsx`            | Detail page                                      | ~150    |
| `apps/studio/src/app/marketplace/category/[category]/page.tsx`         | Category browse page                             | ~80     |
| `apps/studio/src/app/marketplace/search/page.tsx`                      | Search results page                              | ~80     |

### Modified Files

| File                                           | Change Description                                                                                 | Risk |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---- |
| `packages/database/src/models/index.ts`        | Add 3 export lines for Template, TemplateVersion, TemplateAnalyticsEvent                           | Low  |
| `apps/template-store/src/server.ts`            | Add trust proxy, mount marketplace routes + rate limiter + optionalAuth, fix 404 handler (GAP-007) | Med  |
| `apps/studio/src/proxy.ts`                     | Add `isMarketplace` check to SPA catch-all exclusion list (~line 337)                              | Low  |
| `apps/studio/src/components/auth/UserMenu.tsx` | Add "Template Store" MenuItem in dropdown (after Academy entry)                                    | Low  |
| `apps/runtime/Dockerfile`                      | Add `COPY apps/template-store/package.json apps/template-store/package.json`                       | Low  |
| `apps/studio/Dockerfile`                       | Add `COPY apps/template-store/package.json apps/template-store/package.json`                       | Low  |
| `apps/admin/Dockerfile`                        | Add `COPY apps/template-store/package.json apps/template-store/package.json`                       | Low  |
| `apps/search-ai/Dockerfile`                    | Add `COPY apps/template-store/package.json apps/template-store/package.json`                       | Low  |
| `docker-compose.yml`                           | Add template-store service entry (port 3115)                                                       | Low  |

### Deleted Files

None. Phase 1 is entirely additive.

---

## 3. Implementation Phases

### Phase 0: Infrastructure Prerequisites

**Goal**: Unblock all downstream phases by wiring models into the barrel export, syncing Dockerfiles, and adding docker-compose entry.

**Tasks**:

0.1. Add Template, TemplateVersion, TemplateAnalyticsEvent exports to `packages/database/src/models/index.ts`:

```typescript
// --- Template Store ---
export {
  Template,
  type ITemplate,
  type ITemplateScreenshot,
  type IDemoConversationMessage,
} from './template.model.js';
export { TemplateVersion, type ITemplateVersion } from './template-version.model.js';
export {
  TemplateAnalyticsEvent,
  type ITemplateAnalyticsEvent,
} from './template-analytics-event.model.js';
```

0.2. Add `COPY apps/template-store/package.json apps/template-store/package.json` to all 4 app Dockerfiles (`apps/runtime/Dockerfile`, `apps/studio/Dockerfile`, `apps/admin/Dockerfile`, `apps/search-ai/Dockerfile`) in the dependency-copy section (near other `COPY apps/*/package.json` lines).

0.3. Add template-store service to `docker-compose.yml`:

```yaml
template-store:
  build:
    context: .
    dockerfile: apps/template-store/Dockerfile
    target: debug
  ports:
    - '3115:3115'
  env_file: .env
  environment:
    - NODE_ENV=development
    - PORT=3115
  depends_on:
    mongo:
      condition: service_healthy
  volumes:
    - ./apps/template-store/src:/app/apps/template-store/src
  restart: unless-stopped
```

0.4. Rebuild database package: `pnpm build --filter=@agent-platform/database`

**Files Touched**:

- `packages/database/src/models/index.ts` — add 3 export lines
- `apps/runtime/Dockerfile` — add 1 COPY line
- `apps/studio/Dockerfile` — add 1 COPY line
- `apps/admin/Dockerfile` — add 1 COPY line
- `apps/search-ai/Dockerfile` — add 1 COPY line
- `docker-compose.yml` — add template-store service block

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/database` succeeds with 0 errors
- [ ] `import { Template, TemplateVersion, TemplateAnalyticsEvent } from '@agent-platform/database/models'` resolves in a test file
- [ ] `docker compose config` shows template-store service without YAML errors
- [ ] All 4 app Dockerfiles contain `COPY apps/template-store/package.json`

**Test Strategy**: Build verification only — no runtime tests needed.

**Rollback**: Revert the commit. No data changes.

---

### Phase 1: Data Layer + Browse API

**Goal**: Implement the repository layer, 4 browse API endpoints, wire routes into server.ts, create seed script with 8-12 templates.

**Tasks**:

1.1. Create `apps/template-store/src/repos/template-repo.ts`:

```typescript
// Standalone functions (runtime pattern, no class):
export async function findTemplates(
  options: BrowseQuery,
): Promise<{ templates: ITemplate[]; total: number }>;
export async function findTemplateBySlug(slug: string): Promise<ITemplate | null>;
export async function findFeaturedTemplates(): Promise<ITemplate[]>;
export async function findCategories(): Promise<Array<{ name: string; count: number }>>;
export async function incrementViewCount(templateId: string): Promise<void>;
```

- Dynamic import: `const { Template } = await import('@agent-platform/database/models');`
- Browse queries enforce `{ status: 'published', visibility: 'public' }` filter
- Text search via `$text: { $search: query }` with `$meta: 'textScore'` sorting
- Filter composition: build MongoDB filter object from BrowseQuery fields
- Sort mapping: `popular` → `{ installCount: -1 }`, `rating` → `{ ratingAverage: -1 }`, `newest` → `{ createdAt: -1 }`, `updated` → `{ updatedAt: -1 }`
- Categories via MongoDB aggregation: `$match` published+public, `$group` by category, `$project` name+count

  1.2. Create `apps/template-store/src/repos/analytics-repo.ts`:

```typescript
export async function trackEvent(input: TrackEventInput): Promise<void>;
```

- Dynamic import: `const { TemplateAnalyticsEvent } = await import('@agent-platform/database/models');`
- Fire-and-forget: `await TemplateAnalyticsEvent.create({ ...input, createdAt: new Date() })`
- IP hashing: `crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16)`

  1.3. Create `apps/template-store/src/routes/marketplace.ts`:

```typescript
const router = express.Router();

// GET /api/v1/marketplace/templates — browse with filters
router.get('/templates', async (req, res) => { ... });

// GET /api/v1/marketplace/templates/:slug — detail + view count + analytics
router.get('/templates/:slug', async (req, res) => { ... });

// GET /api/v1/marketplace/categories — categories with counts
router.get('/categories', async (req, res) => { ... });

// GET /api/v1/marketplace/featured — featured templates (flat array)
router.get('/featured', async (req, res) => { ... });

export default router;
```

- Zod validation on browse query params (`BrowseQuerySchema`)
- Analytics event classification in browse handler: `q` present → `search`, `category` present → `category_browse`, else → `marketplace_view`
- Slug param validation: `z.string().min(1).max(100).regex(/^[a-z0-9-]+$/)` — reject invalid slugs with 400
- Detail handler: find by slug, increment view count, record `detail_view` event, load latest version
- All responses use `{ success: true, data: { ... } }` envelope
- Errors use `AppError` from shared-kernel

  1.4. Wire routes into `apps/template-store/src/server.ts`:

- Line 28: Add `app.set('trust proxy', 1);`
- After observability middleware: Add `app.use('/api/v1/marketplace', optionalAuth, rateLimiter, marketplaceRouter);`
- Fix 404 handler (lines 91-93): `res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });`
- Replace `extractClientIp()` in `rate-limit.ts`: delete the manual XFF parsing function and replace all calls with `req.ip` (trust proxy handles XFF resolution). Before: `extractClientIp(req)` parses `x-forwarded-for` header manually. After: `req.ip` returns the correct client IP because `app.set('trust proxy', 1)` is set in task 1.4

  1.5. Create `apps/template-store/src/scripts/seed-templates.ts`:

- Define 8-12 seed templates (both `agent` and `project` types):
  - 4 agent templates: Customer Service, Technical Support, Sales Advisor, Knowledge Worker
  - 4 project templates: Customer Support Team, Sales Pipeline, HR Onboarding, IT Helpdesk
  - Optional 2-4 more: Financial Advisor, Healthcare Intake, E-commerce Assistant, Legal Research
- Each template includes: slug, name, shortDescription, longDescription, type, typeMetadata, category, tags, complexity, detailSections, demoConversation (3-5 messages), publisher info (ABL Platform, verified)
- Screenshots: use placeholder URLs initially (GAP-006 — product team refines later)
- Upsert by slug: `Template.findOneAndUpdate({ slug }, { $set: data }, { upsert: true })`
- Upsert matching TemplateVersion (version "1.0.0") for each template: `TemplateVersion.findOneAndUpdate({ templateId, version: '1.0.0' }, { $set: versionData }, { upsert: true })`
- Set 3-4 templates as featured with `featuredOrder` values
- Invocation: `pnpm tsx apps/template-store/src/scripts/seed-templates.ts`

  1.6. Rebuild template-store: `pnpm build --filter=@agent-platform/template-store`

**Files Touched**:

- `apps/template-store/src/repos/template-repo.ts` — new
- `apps/template-store/src/repos/analytics-repo.ts` — new
- `apps/template-store/src/routes/marketplace.ts` — new
- `apps/template-store/src/scripts/seed-templates.ts` — new
- `apps/template-store/src/server.ts` — add trust proxy, mount routes, fix 404
- `apps/template-store/src/middleware/rate-limit.ts` — simplify extractClientIp

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/template-store` succeeds with 0 errors
- [ ] `GET /health` returns 200 with MongoDB status
- [ ] `GET /ready` returns 200
- [ ] Seed script runs successfully: `pnpm tsx apps/template-store/src/scripts/seed-templates.ts` creates 8+ templates
- [ ] `GET /api/v1/marketplace/templates` returns paginated list of seeded templates
- [ ] `GET /api/v1/marketplace/templates?type=agent` returns only agent templates
- [ ] `GET /api/v1/marketplace/templates?q=customer` returns text search results
- [ ] `GET /api/v1/marketplace/templates/customer-service-agent` returns detail + increments view count
- [ ] `GET /api/v1/marketplace/categories` returns category names with correct counts
- [ ] `GET /api/v1/marketplace/featured` returns templates ordered by featuredOrder
- [ ] Invalid slug returns `{ success: false, error: { code: 'NOT_FOUND' } }`
- [ ] Invalid query params return 400 with standard error format
- [ ] All responses include `x-request-id` header
- [ ] Rate limiter returns 429 after configured threshold

**Test Strategy**: Manual smoke testing via curl against running service. Integration tests deferred to Phase 3.

**Rollback**: Revert commit. Drop `templates`, `template_versions`, `template_analytics_events` collections if seeded.

---

### Phase 2: Studio Marketplace UI

**Goal**: Implement the Studio marketplace pages (landing, detail, category, search) with navigation entry and all UI components.

**Tasks**:

2.1. Add `/marketplace` exclusion to Studio proxy SPA catch-all:

In `apps/studio/src/proxy.ts`, add `isMarketplace` check near other path checks (~line 129 and ~line 337):

```typescript
const isMarketplace = pathname.startsWith('/marketplace');
// In the SPA catch-all condition (~line 337):
if (!isApi && !isAuth && !isAcademy && !isMarketplace && !isDocs && ...) {
```

2.2. Create `apps/studio/src/store/marketplace-store.ts`:

Following the Academy Store pattern with `apiFetch`:

```typescript
interface MarketplaceState {
  // Browse state
  templates: ITemplate[];
  total: number;
  loading: boolean;
  error: string | null;

  // Filters
  query: string;
  category: string | null;
  templateType: 'agent' | 'project' | null;
  complexity: 'starter' | 'standard' | 'advanced' | null;
  sort: 'popular' | 'rating' | 'newest' | 'updated';
  page: number;

  // Detail state
  selectedTemplate: ITemplate | null;
  selectedVersion: ITemplateVersion | null;
  detailLoading: boolean;

  // Categories
  categories: Array<{ name: string; count: number }>;

  // Featured
  featured: ITemplate[];

  // Actions
  fetchTemplates: () => Promise<void>;
  fetchTemplateDetail: (slug: string) => Promise<void>;
  fetchCategories: () => Promise<void>;
  fetchFeatured: () => Promise<void>;
  setQuery: (q: string) => void;
  setCategory: (cat: string | null) => void;
  setTemplateType: (type: 'agent' | 'project' | null) => void;
  setComplexity: (c: 'starter' | 'standard' | 'advanced' | null) => void;
  setSort: (s: 'popular' | 'rating' | 'newest' | 'updated') => void;
  setPage: (p: number) => void;
  resetFilters: () => void;
}
```

- API calls use `apiFetch('/api/template-store/marketplace/...')` via `import { apiFetch } from '@/lib/api-client'` (Studio proxy rewrites to service)
- 300ms debounced search via `query` state changes
- Export standalone selectors (matching academy-store pattern):

```typescript
export const selectTemplates = (s: MarketplaceState) => s.templates;
export const selectMarketplaceLoading = (s: MarketplaceState) => s.loading;
export const selectMarketplaceError = (s: MarketplaceState) => s.error;
export const selectCategories = (s: MarketplaceState) => s.categories;
export const selectFeatured = (s: MarketplaceState) => s.featured;
export const selectSelectedTemplate = (s: MarketplaceState) => s.selectedTemplate;
```

2.3. Create `apps/studio/src/app/marketplace/layout.tsx` and `apps/studio/src/components/marketplace/MarketplaceLayout.tsx`:

Following the Academy layout pattern:

- `layout.tsx`: thin server wrapper — `import { MarketplaceLayout } from '@/components/marketplace/MarketplaceLayout'; export default function MarketplaceRootLayout({ children }) { return <MarketplaceLayout>{children}</MarketplaceLayout>; }`
- `MarketplaceLayout.tsx`: `'use client'` component with header bar (h-12), title "Template Store", tabbed nav (Browse / Categories / Search), "Back to Studio" link (`window.location.href = '/'`), main area with `overflow-y-auto p-6` wrapping `{children}`
- Matches `AcademyLayout` pattern — self-contained, no AppShell wrapping

  2.4. Create `apps/studio/src/components/marketplace/TemplateCard.tsx`:

- Display: name, shortDescription, type badge (reuse TemplateTypeBadge), category badge, complexity indicator, install count, view count, rating
- Click handler: navigate to `/marketplace/templates/${slug}`
- Use i18n keys from `marketplace` namespace
- Responsive: full width on mobile, card grid on desktop

  2.5. Create `apps/studio/src/components/marketplace/CategoryGrid.tsx`:

- Grid of category cards with icon (from a category→icon map), name, template count
- Click handler: navigate to `/marketplace/category/${categoryName}`
- Use `useTranslations('marketplace')` for category display names

  2.6. Create `apps/studio/src/components/marketplace/TemplateSearchBar.tsx`:

- Search input with 300ms debounce
- Filter dropdowns: type (Agent/Project), category, complexity
- Sort dropdown: popular, rating, newest, updated
- Reset filters button
- Connected to marketplace-store actions

  2.7. Create `apps/studio/src/app/marketplace/page.tsx` (landing page):

- Hero section with title and subtitle (i18n)
- Featured templates section (horizontal scroll or grid)
- Category grid
- Recent additions section
- Fetch on mount: `fetchFeatured()`, `fetchCategories()`, `fetchTemplates()`

  2.8. Create `apps/studio/src/app/marketplace/templates/[slug]/page.tsx` (detail page):

- Hero: template name, publisher, type badge, complexity, stats (installs, views, rating)
- Composable tabs based on `detailSections` array:
  - `agent-summary`: agent config overview from typeMetadata
  - `demo-conversation`: render DemoConversation component
  - `config-preview`: render TemplateConfigPreview component
- Screenshots gallery
- "Coming Soon" placeholder for install button (Phase 2+)
- Back navigation

  2.9. Create remaining UI components:

- `TemplateScreenshotGallery.tsx`: thumbnail grid, lightbox on click
- `DemoConversation.tsx`: alternating message bubbles (user/agent styling)
- `TemplateConfigPreview.tsx`: read-only display of manifest config fields

  2.10. Create category browse page (`apps/studio/src/app/marketplace/category/[category]/page.tsx`):

- Category name as heading (from URL param)
- TemplateSearchBar with category pre-selected
- Paginated template grid
- Breadcrumb: Marketplace > Category Name

  2.11. Create search results page (`apps/studio/src/app/marketplace/search/page.tsx`):

- TemplateSearchBar at top
- Paginated results grid
- Empty state when no results

  2.12. Add "Template Store" navigation entry to Studio:

In `apps/studio/src/components/auth/UserMenu.tsx`, add a `MenuItem` for Template Store in the dropdown menu (after the Academy entry), matching the Academy pattern:

```tsx
<MenuItem
  icon={<Store className="w-4 h-4" />}
  label={t('templateStore')}
  onClick={() => {
    setIsOpen(false);
    window.location.href = '/marketplace';
  }}
/>
```

- Import `Store` from `lucide-react`
- Use `window.location.href` (full page navigation, NOT SPA `navigate()`) because marketplace lives outside AppShell
- Add i18n key `templateStore` to the `user_menu` section in `packages/i18n/locales/en/studio.json`

  2.13. Rebuild Studio: `pnpm build --filter=@agent-platform/studio`

**Files Touched**:

- `apps/studio/src/proxy.ts` — add marketplace exclusion
- `apps/studio/src/store/marketplace-store.ts` — new
- `apps/studio/src/components/marketplace/TemplateCard.tsx` — new
- `apps/studio/src/components/marketplace/CategoryGrid.tsx` — new
- `apps/studio/src/components/marketplace/TemplateSearchBar.tsx` — new
- `apps/studio/src/components/marketplace/TemplateScreenshotGallery.tsx` — new
- `apps/studio/src/components/marketplace/DemoConversation.tsx` — new
- `apps/studio/src/components/marketplace/TemplateConfigPreview.tsx` — new
- `apps/studio/src/app/marketplace/layout.tsx` — new (thin wrapper)
- `apps/studio/src/components/marketplace/MarketplaceLayout.tsx` — new (client layout)
- `apps/studio/src/app/marketplace/page.tsx` — new
- `apps/studio/src/app/marketplace/templates/[slug]/page.tsx` — new
- `apps/studio/src/app/marketplace/category/[category]/page.tsx` — new
- `apps/studio/src/app/marketplace/search/page.tsx` — new
- `apps/studio/src/components/auth/UserMenu.tsx` — add Template Store menu item

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/studio` succeeds with 0 errors
- [ ] Navigating to `/marketplace` in Studio renders the landing page with featured templates, category grid, and recent additions
- [ ] Clicking a template card navigates to `/marketplace/templates/:slug` with detail page
- [ ] Search bar filters templates (debounced, 300ms)
- [ ] Type/category/complexity filters narrow results
- [ ] Category page shows filtered templates with breadcrumb
- [ ] "Template Store" appears in UserMenu dropdown (after Academy)
- [ ] All user-facing strings use i18n (`marketplace` namespace)
- [ ] Studio proxy correctly routes `/api/template-store/*` to the template store service
- [ ] `/marketplace` routes render via Next.js App Router (not caught by SPA catch-all)

**Test Strategy**: Manual visual verification. Component tests deferred to Phase 3.

**Rollback**: Revert commit. Remove marketplace pages and components.

---

### Phase 3: Testing

**Goal**: Implement all integration tests, unit tests, and E2E tests from the test spec.

**Tasks**:

3.1. Create integration tests (`apps/template-store/src/__tests__/routes/marketplace.test.ts`):

- Start real Express server on random port (`{ port: 0 }`)
- Seed test data via Mongoose models in `beforeAll` setup (seeding is infrastructure setup, not assertion)
- **All assertions must be via HTTP only** — verify response bodies, status codes, and headers. Never query MongoDB directly to assert state (e.g., verify view count via the GET detail endpoint, not via `Template.findOne()`)
- No mocking of codebase components
- Cover all 7 integration scenarios from test spec:
  - INT-1: Browse with pagination (25 seeded, page 1/3)
  - INT-2: Filter by type, category, complexity (intersection)
  - INT-3: Full-text search
  - INT-4: Template detail + view count + analytics event
  - INT-5: Categories with counts + featured ordering
  - INT-6: Rate limiting (429 on excess)
  - INT-7: Request ID + error format validation
- Additionally, cover Security & Isolation scenarios #1-2 from the test spec (draft/archived template exclusion): seed 3 published + 2 draft + 1 archived templates; GET browse; verify only 3 published returned; GET detail for a draft slug → 404. These are part of the test spec's Security table, not numbered INT scenarios.

  3.2. Create unit tests for repos (`apps/template-store/src/__tests__/repos/`):

- `template-repo.test.ts`: filter construction, sort mapping, pagination offset/limit
- `analytics-repo.test.ts`: event creation, IP hashing, nullable fields

  3.3. Create unit tests for UI components (`apps/studio/src/__tests__/components/marketplace/`):

- `TemplateTypeBadge.test.tsx`: renders correct label/color for agent, project, unknown
- `TemplateCard.test.tsx`: renders fields, click fires navigation
- `CategoryGrid.test.tsx`: renders cards with counts, click navigates
- `TemplateSearchBar.test.tsx`: debounced search, filter dropdowns, reset
- `TemplateScreenshotGallery.test.tsx`: renders thumbnails, lightbox on click, navigation
- `DemoConversation.test.tsx`: renders alternating user/agent message bubbles
- `TemplateConfigPreview.test.tsx`: renders config schema fields in read-only mode

  3.4. Create marketplace store tests (`apps/studio/src/__tests__/store/marketplace-store.test.ts`):

- `fetchTemplates`: loading → success → data populated; loading → error → error message
- `fetchTemplateDetail`: loads detail into selectedTemplate
- Filter actions: verify state updates correctly
- `resetFilters`: clears all to defaults

  3.5. Create E2E tests (Playwright, `apps/studio/e2e/`):

- `marketplace-landing.spec.ts`: landing page renders, featured templates, category grid
- `marketplace-detail.spec.ts`: detail page, tabs, demo conversation, coming-soon install
- `marketplace-search.spec.ts`: search, filters, sort, combinations, empty state
- `marketplace-category.spec.ts`: category browse, pagination, breadcrumbs
- `marketplace-responsive.spec.ts`: mobile/tablet/desktop layout

**Files Touched**:

- `apps/template-store/src/__tests__/routes/marketplace.test.ts` — new
- `apps/template-store/src/__tests__/repos/template-repo.test.ts` — new
- `apps/template-store/src/__tests__/repos/analytics-repo.test.ts` — new
- `apps/studio/src/__tests__/components/marketplace/*.test.tsx` — new (7 files)
- `apps/studio/src/__tests__/store/marketplace-store.test.ts` — new
- `apps/studio/e2e/marketplace-*.spec.ts` — new (5 files)

**Exit Criteria**:

- [ ] All 7 integration test scenarios pass (INT-1 through INT-7) plus Security & Isolation scenarios #1-2
- [ ] Unit tests for template-repo and analytics-repo pass
- [ ] Unit tests for all 7 marketplace UI components pass (TemplateTypeBadge, TemplateCard, CategoryGrid, TemplateSearchBar, TemplateScreenshotGallery, DemoConversation, TemplateConfigPreview)
- [ ] Marketplace store tests pass
- [ ] All 5 E2E test scenarios pass
- [ ] Security tests pass: draft/archived templates hidden, rate limiting enforced, CORS present
- [ ] `pnpm test` (full suite) passes with no regressions

**Note on INT-4**: Test spec says "Verify `viewCount` incremented to 1 in the database" — per CLAUDE.md E2E standards, viewCount is verified via a second GET to the detail endpoint, not via direct DB query.

3.6. Create `apps/template-store/agents.md` with package-specific implementation learnings (service boundaries discovered, undocumented dependencies, config quirks, testing patterns).

**Test Strategy**: Real servers, real MongoDB, no mocking codebase components per CLAUDE.md. Only external third-party services may be mocked via DI.

**Rollback**: Revert commit. Tests only — no production code changes.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.

- [ ] Template, TemplateVersion, TemplateAnalyticsEvent exported from `packages/database/src/models/index.ts` (Phase 0, task 0.1)
- [ ] Marketplace routes registered in `apps/template-store/src/server.ts` via `app.use('/api/v1/marketplace', ...)` (Phase 1, task 1.4)
- [ ] `optionalAuth` middleware mounted before marketplace routes in server.ts (Phase 1, task 1.4)
- [ ] Rate limiter mounted on marketplace routes in server.ts (Phase 1, task 1.4)
- [ ] Trust proxy set: `app.set('trust proxy', 1)` in server.ts (Phase 1, task 1.4)
- [ ] 404 handler fixed to standard error format in server.ts (Phase 1, task 1.4)
- [ ] `/marketplace` excluded from Studio SPA catch-all in proxy.ts (Phase 2, task 2.1)
- [ ] "Template Store" MenuItem added to UserMenu.tsx dropdown (Phase 2, task 2.12)
- [ ] Marketplace pages exist at `apps/studio/src/app/marketplace/` with layout.tsx (Phase 2, tasks 2.3, 2.7-2.11)
- [ ] Marketplace store imported and used by page components (Phase 2, tasks 2.6-2.10)
- [ ] `COPY apps/template-store/package.json` in all 4 app Dockerfiles (Phase 0, task 0.2)
- [ ] Template-store service in docker-compose.yml (Phase 0, task 0.3)
- [ ] Seed script runnable via `pnpm tsx apps/template-store/src/scripts/seed-templates.ts` (Phase 1, task 1.5)

---

## 5. Cross-Phase Concerns

### Database Migrations

None. Greenfield — MongoDB auto-creates collections on first write. Indexes defined in Mongoose schemas, auto-created when `autoIndex: true` (development default).

### Feature Flags

None. Binary rollout per HLD decision.

### Known Gaps (Carried from HLD)

| ID      | Description                                                                                                                                                                   | Severity | Resolution                                                                                                |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| GAP-003 | Rate limiter is in-memory (`express-rate-limit`). Not shared across pods. In multi-pod deployment, each pod tracks independently — effective limit is `N × configured limit`. | MEDIUM   | Acceptable for Phase 1 (single pod). Phase 2+: migrate to Redis-backed rate limiter (`rate-limit-redis`). |
| GAP-004 | `userAgent` field in analytics events (PII concern). Feature spec includes it but HLD flags privacy risk.                                                                     | LOW      | Omitted from Phase 1 `TrackEventInput`. Revisit with legal/privacy review.                                |
| GAP-006 | Seed template content quality — engineering creates representative content, product refines.                                                                                  | MEDIUM   | Phase 1 seeds 8-12 templates with representative content. Product refines post-launch.                    |

### Configuration Changes

| Variable                  | Default                 | Where          | Phase                          |
| ------------------------- | ----------------------- | -------------- | ------------------------------ |
| `TEMPLATE_STORE_URL`      | `http://localhost:3115` | Studio `.env`  | Existing (proxy already wired) |
| `PORT`                    | `3115`                  | Template Store | Existing                       |
| `MONGODB_URL`             | (from `.env`)           | Template Store | Existing                       |
| `RATE_LIMIT_WINDOW_MS`    | `60000`                 | Template Store | Existing                       |
| `RATE_LIMIT_MAX_REQUESTS` | `100`                   | Template Store | Existing                       |
| `CORS_ORIGINS`            | (empty)                 | Template Store | Existing                       |
| `MARKETING_SITE_URL`      | (empty)                 | Template Store | Existing                       |

No new environment variables needed — all are already defined in `apps/template-store/src/config.ts`.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All phases complete (0-3) with exit criteria met
- [ ] All 15 FRs from feature spec verified functional
- [ ] 7 integration tests pass (INT-1-7) plus security & isolation scenarios
- [ ] 5 E2E tests pass
- [ ] Unit tests pass for repos, components, store
- [ ] No regressions in existing tests (`pnpm build && pnpm test`)
- [ ] Feature spec updated with actual file paths and implementation status
- [ ] Test spec coverage matrix updated with actual test status
- [ ] 8-12 seed templates exist with representative content
- [ ] p95 API response time < 200ms
- [ ] All user-facing strings use i18n
- [ ] `apps/template-store/agents.md` created with implementation learnings

---

## 7. Open Questions

1. **Seed template content depth**: Should engineering create full-quality demo conversations and descriptions, or placeholder content that product refines? (Recommended: engineering creates representative content, product refines descriptions/screenshots in a follow-up.)

2. **Screenshot handling**: Phase 1 stores screenshot URLs in the template document. Where do the actual images live? Options: (a) static assets in the repo, (b) public URLs (e.g., CDN), (c) placeholder images. (Recommended: placeholder icons/images from lucide-react or a static asset folder, refined later.)

3. **UserMenu navigation placement**: The exact UI position of the "Template Store" link in the UserMenu dropdown needs UX validation. The LLD specifies placement after the Academy entry, using `window.location.href` for full-page navigation.
