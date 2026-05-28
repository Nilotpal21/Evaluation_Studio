# Feature: Studio Theme System & Internal Docs Integration

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: PLANNED
**Feature Area(s)**: `admin operations`, `customer experience`, `governance`
**Package(s)**: `apps/studio`, `apps/docs-internal` (source, to be migrated)
**Owner(s)**: `Studio team`
**Testing Guide**: `../../testing/ancillary/studio-theme-docs-integration.md`
**Last Updated**: 2026-03-25

---

## 1. Introduction / Overview

### Problem Statement

Studio currently has a theme toggle icon (sun/moon) in the header bar that only cycles between light and dark modes, losing the "system" preference option. The toggle takes up header real estate and doesn't match the pattern used by modern apps (Linear, Vercel, GitHub) where theme selection lives in user settings. Additionally, `apps/docs-internal/` is a standalone Next.js app with its own deployment infrastructure (PM2 process at port 3007, `package.json` referenced in 6 Dockerfiles for pnpm workspace resolution) that adds operational overhead. It has no Dockerfile of its own, no Helm chart, and no docker-compose entry — meaning it can only run locally via PM2 but cannot be deployed to production. It shares Google OAuth credentials with Studio but manages a completely independent JWT session, creating further overhead for what is a read-only documentation site used only by internal team members.

### Goal Statement

Consolidate the theme switcher into the UserMenu with system/light/dark options (defaulting to system), and migrate the internal docs content into Studio as a `/docs` route group with email-domain access control — eliminating a separate app without impacting Studio's performance or security.

### Summary

This feature has two parts:

1. **Theme System Cleanup**: Remove the `<ThemeToggle>` icon from the header. Add a theme selector (System / Light / Dark) in the UserMenu dropdown, using the existing `theme-store.ts` infrastructure. Default mode is `system` (respects OS preference). The existing CSS design tokens for both `[data-theme='light']` and `:root` (dark) are already complete.

2. **Internal Docs Integration**: Move 74 MDX files and the rendering pipeline from `apps/docs-internal/` into Studio under `/docs/[...slug]`. Access is gated by email-domain allowlist (configurable via `DOCS_ALLOWED_DOMAINS` env var, defaulting to `kore.ai,kore.com`). Non-allowed users get a 404 (not 403, per platform invariant). The MDX pipeline (`next-mdx-remote`, `gray-matter`, `remark-gfm`, `mermaid`) is fully code-split to the `/docs` route — zero bundle impact on other Studio routes. Docs inherit Studio's theme system natively.

---

## 2. Scope

### Goals

- Remove `<ThemeToggle>` from the Studio header bar
- Add system/light/dark theme selector in UserMenu with checkmark on active mode
- Default theme mode is `system` (resolves to light or dark based on OS preference)
- Migrate all 74 MDX docs and 6 MDX components from `apps/docs-internal/` into Studio
- Protect `/docs` routes with email-domain allowlist (configurable via env var)
- Return 404 to non-allowed users (no existence leaking)
- Code-split all docs dependencies — zero performance impact on non-docs routes
- Docs inherit Studio's theme (light/dark/system) — no separate theme tokens
- Add "Docs" link in UserMenu (visible only to allowed-domain users)

### Non-Goals (Out of Scope)

- MDX content authoring/editing from Studio UI (content is authored in repo via git)
- RBAC/permission-based access control for docs (email-domain is sufficient for static internal docs)
- Removing the `apps/docs-internal/` directory (cleanup is a separate follow-up commit after migration is verified)
- Adding new documentation content — only migrating existing 74 MDX files
- Search functionality within docs (can be added later)
- Changing Studio's dark-mode CSS token values — only wiring up the theme selector UI

---

## 3. User Stories

1. As a **Studio user**, I want to select my theme preference (system, light, dark) from the user menu so that I don't have a standalone icon cluttering the header.
2. As a **Studio user with system preference**, I want my theme to automatically match my OS setting so that Studio feels native alongside my other apps.
3. As an **internal team member (kore.ai/kore.com)**, I want to access platform documentation directly within Studio at `/docs` so that I don't need a separate app or URL.
4. As an **internal team member**, I want docs to respect my chosen Studio theme so that dark-mode docs don't flash white when I'm in dark mode.
5. As an **external user** (non kore.ai/kore.com), I want to see no trace of the docs section so that internal documentation is not leaked.
6. As a **platform operator**, I want the docs domain allowlist configurable via environment variable so that I can adjust access without redeploying code.

---

## 4. Functional Requirements

1. **FR-1**: The system must remove the `<ThemeToggle>` component from the AppShell header bar (`AppShell.tsx:306`).
2. **FR-2**: The system must add a "Theme" section in the UserMenu dropdown with three options: System, Light, Dark — each showing a checkmark icon when active, following the existing workspace-switcher MenuItem pattern.
3. **FR-3**: The system must default to `system` theme mode for new users (no `kore-theme-storage` in localStorage). The `system` mode resolves to light or dark based on `prefers-color-scheme` media query.
4. **FR-4**: The system must persist theme preference to localStorage (`kore-theme-storage`) and apply it before first paint via the existing `THEME_INIT_SCRIPT` in `layout.tsx`.
5. **FR-5**: The system must serve MDX documentation at `/docs/[...slug]` routes using `next-mdx-remote/rsc` with `remark-gfm` for GFM support.
6. **FR-6**: The system must load MDX content from a `content/` directory within `apps/studio/` using filesystem reads (`gray-matter` + `fs.promises`), with the directory included in `outputFileTracingIncludes` for standalone builds.
7. **FR-7**: The system must gate `/docs` routes by checking the authenticated user's email domain against the `DOCS_ALLOWED_DOMAINS` environment variable (comma-separated, default: `kore.ai,kore.com`).
8. **FR-8**: The system must return 404 (not 403) when a non-allowed user navigates to any `/docs` route — no leaking of existence.
9. **FR-9**: The system must render a "Docs" MenuItem in the UserMenu (with `BookOpen` icon) only when the authenticated user's email domain is in the allowlist.
10. **FR-10**: The system must code-split all docs-specific dependencies (`next-mdx-remote`, `gray-matter`, `remark-gfm`, `mermaid`) so they are only loaded when a `/docs` route is visited.
11. **FR-11**: The system must render Mermaid diagrams via lazy dynamic import (`import('mermaid')`) only when a page contains mermaid code blocks — not preloaded for all docs pages.
12. **FR-12**: The system must use Studio's existing semantic design tokens (`--background`, `--foreground`, `--border`, etc.) for all docs styling — no docs-specific color overrides.
13. **FR-13**: The system must replace all hardcoded Tailwind palette colors (e.g., `bg-gray-900`, `text-gray-100`, `bg-blue-50`, `text-slate-700`) in migrated MDX rendering components (`CustomPre`, `CustomCode`, `Mermaid`, `Callout`, `Milestone`) with semantic design tokens from `globals.css`. Callout info/warning/tip variants map to `--info`/`--warning`/`--success` token families.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                        |
| -------------------------- | ------------ | ------------------------------------------------------------ |
| Project lifecycle          | NONE         | Docs are not project-scoped                                  |
| Agent lifecycle            | NONE         | No agent interaction                                         |
| Customer experience        | SECONDARY    | Theme preference improves UX; docs help internal onboarding  |
| Integrations / channels    | NONE         | No channel impact                                            |
| Observability / tracing    | NONE         | No trace events                                              |
| Governance / controls      | SECONDARY    | Email-domain gating is an access control mechanism           |
| Enterprise / compliance    | SECONDARY    | Internal docs protected behind domain allowlist              |
| Admin / operator workflows | PRIMARY      | Theme UX change in header; env var config for docs allowlist |

### Related Feature Integration Matrix

| Related Feature                                     | Relationship Type | Why It Matters                                             | Key Touchpoints                                  | Current State      |
| --------------------------------------------------- | ----------------- | ---------------------------------------------------------- | ------------------------------------------------ | ------------------ |
| [SSO / Enterprise Auth](sso-enterprise-auth.md)     | depends on        | Docs rely on Studio's auth to identify user email          | `requireAuth()`, `useAuthStore().user.email`     | STABLE auth system |
| [Agent Dev Studio](agent-development-studio.md)     | shares data with  | Theme preference applies to Studio and docs equally        | `theme-store.ts`, `globals.css` design tokens    | ThemeToggle exists |
| [Gradient Design Tokens](gradient-design-tokens.md) | extends           | Docs use the same gradient/token system as Studio          | `globals.css`, `@agent-platform/tailwind-config` | Tokens defined     |
| [CORS](cors.md)                                     | configured by     | Docs route is internal to Studio, no cross-origin concerns | Same-origin API calls                            | CORS configured    |

---

## 6. Design Considerations

### Theme Selector in UserMenu

The theme selector replaces the header icon with three `MenuItem` rows in the UserMenu, placed in a new "Appearance" section between the menu items and the logout divider:

```
┌──────────────────────────┐
│ User Name                │
│ user@kore.ai             │
├──────────────────────────┤
│ 🏢 Switch Workspace   ▼ │
├──────────────────────────┤
│ 👤 Profile               │
│ 🔑 API Keys              │
│ 🛡️ Admin           G A   │
│ 📖 Docs                  │  ← Only for allowed domains
├──────────────────────────┤
│ 🖥️ System          ✓     │  ← Theme section
│ ☀️ Light                  │
│ 🌙 Dark                  │
├──────────────────────────┤
│ 🚪 Sign out              │
└──────────────────────────┘
```

Uses lucide icons: `Monitor` (system), `Sun` (light), `Moon` (dark), `Check` (active indicator). Follows the existing `MenuItem` component pattern with `Check` icon alignment matching the workspace switcher.

### Docs Layout

The `/docs` route group uses a dedicated layout with:

- Docs sidebar (section navigation) in the main content area
- MDX content rendered in the center
- Studio's AppShell remains (header, nav) — docs is just another "area" like project or admin
- Prose typography via `@tailwindcss/typography` scoped to docs content

---

## 7. Technical Considerations

### Performance Isolation

- All docs dependencies (`next-mdx-remote`, `gray-matter`, `remark-gfm`, `mermaid`) are only imported in `/docs` route files — Next.js route-based code splitting ensures they are not in the main Studio bundle
- `mermaid` (~200KB) is additionally lazy-loaded per-component via dynamic `import('mermaid')` — only fetched when a page contains mermaid diagrams
- MDX rendering uses `next-mdx-remote/rsc` (React Server Components) — content is rendered server-side with zero client JS for the MDX body itself
- Content filesystem reads happen server-side only — no client bundle impact

### Security

- Uses Studio's existing `requireAuth()` — no custom token verification or independent OAuth
- Email domain check is performed server-side in the `/docs` layout or middleware
- Non-allowed users receive 404, consistent with platform invariant on cross-scope access
- No new API routes needed — content is read from filesystem, not an API
- `DOCS_ALLOWED_DOMAINS` env var follows Studio's pattern of runtime config via `process.env`

### Standalone Build

Studio uses `output: 'standalone'` in `next.config.mjs`. The `content/` directory contains MDX files read at runtime via `fs.promises`. These must be included via `outputFileTracingIncludes`:

```js
experimental: {
  outputFileTracingIncludes: {
    '/docs': ['./content/**/*'],
  },
}
```

This matches the existing pattern at `next.config.mjs:36-38` for the SDK embed script.

### Migration Strategy

The `apps/docs-internal/` directory remains untouched during this feature. Content and components are **copied** into Studio, not moved. Once the migration is verified working, a separate cleanup commit must:

- Remove `apps/docs-internal/` directory
- Remove the 6 `COPY apps/docs-internal/package.json` lines from `apps/{runtime,studio,admin,search-ai,search-ai-runtime,multimodal-service}/Dockerfile`
- Remove the PM2 entry (`abl-docs-internal`) from `ecosystem.config.js`
- Remove the `apx` CLI references (health check, `APPS_CORE` group)
- Remove port 3007 from `packages/config/src/constants.ts`

---

## 8. How to Consume

### Studio UI

**Theme**: User menu → Appearance section → System / Light / Dark. Persists to localStorage. Applies immediately with smooth transition animation (existing `theme-transition` CSS class).

**Docs**: User menu → "Docs" link (visible only for allowed-domain users) → navigates to `/docs/getting-started`. Docs sidebar provides section navigation. Direct URL access at `/docs/<section>/<page>` also works.

### API (Runtime)

N/A — This feature does not affect the Runtime API.

### API (Studio)

| Method | Path              | Purpose                                       |
| ------ | ----------------- | --------------------------------------------- |
| GET    | `/docs/[...slug]` | Server-rendered MDX page (Next.js page route) |

No API routes needed — docs config is loaded server-side in the `/docs` layout, and content is read from the filesystem.

### Admin Portal

N/A — No admin-facing changes. The `DOCS_ALLOWED_DOMAINS` env var is configured at deployment time.

### Channel / SDK / Voice / A2A / MCP Integration

N/A — This feature is not channel-aware.

---

## 9. Data Model

### Collections / Tables

N/A — No database collections.

### Filesystem Data

- `apps/studio/content/**/*.mdx` — 74 MDX files read at runtime via `gray-matter` + `fs.promises.readFile`
- `apps/studio/docs.config.json` — Navigation structure config (sections with slug/title pairs, allowedDomains)
- `localStorage('kore-theme-storage')` — Client-side theme preference (Zustand persist)

### Key Relationships

- Theme preference: `localStorage('kore-theme-storage')` → `theme-store.ts` (Zustand) → `data-theme` attribute on `<html>`
- Docs content: `apps/studio/content/<section>/<slug>.mdx` → `content.ts` (gray-matter parser) → `next-mdx-remote/rsc` renderer → `/docs/[...slug]/page.tsx`
- Access control: `useAuthStore().user.email` → domain extraction → check against `DOCS_ALLOWED_DOMAINS`

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                   | Purpose                                            |
| -------------------------------------- | -------------------------------------------------- |
| `apps/studio/src/store/theme-store.ts` | Zustand store for theme mode (existing, unchanged) |
| `apps/studio/src/lib/docs/content.ts`  | MDX content loader (migrated from docs-internal)   |
| `apps/studio/src/lib/docs/config.ts`   | Docs config loader (sections, navigation)          |
| `apps/studio/src/lib/docs/access.ts`   | Email-domain allowlist check                       |

### Routes / Handlers

| File                                          | Purpose                                  |
| --------------------------------------------- | ---------------------------------------- |
| `apps/studio/src/app/docs/layout.tsx`         | Docs layout with sidebar + access gate   |
| `apps/studio/src/app/docs/[...slug]/page.tsx` | Catch-all MDX renderer                   |
| `apps/studio/src/app/docs/page.tsx`           | Root redirect to `/docs/getting-started` |

### UI Components

| File                                                 | Purpose                                      |
| ---------------------------------------------------- | -------------------------------------------- |
| `apps/studio/src/components/auth/UserMenu.tsx`       | Modified: add theme selector + docs link     |
| `apps/studio/src/components/navigation/AppShell.tsx` | Modified: remove `<ThemeToggle />`           |
| `apps/studio/src/components/docs/DocsSidebar.tsx`    | Docs section navigation sidebar              |
| `apps/studio/src/components/docs/mdx/Callout.tsx`    | MDX callout component (migrated)             |
| `apps/studio/src/components/docs/mdx/Mermaid.tsx`    | MDX mermaid renderer (migrated, lazy-loaded) |
| `apps/studio/src/components/docs/mdx/Milestone.tsx`  | MDX milestone timeline (migrated)            |
| `apps/studio/src/components/docs/mdx/index.tsx`      | MDX component map + CustomPre/CustomCode     |

### Jobs / Workers / Background Processes

N/A — No background processing.

### Tests

| File                                                     | Type        | Coverage Focus                                            |
| -------------------------------------------------------- | ----------- | --------------------------------------------------------- |
| `apps/studio/src/__tests__/docs-access.test.ts`          | unit        | Email domain allowlist logic (UT-1,2,3)                   |
| `apps/studio/src/__tests__/docs-content.test.ts`         | unit+integ  | MDX content loading, frontmatter parsing (INT-1,2,3,8,10) |
| `apps/studio/src/__tests__/docs-config.test.ts`          | unit        | Docs config loader (UT-6,7)                               |
| `apps/studio/src/__tests__/docs-mdx-components.test.ts`  | integration | MDX semantic token verification (INT-5,6,7,9,11)          |
| `apps/studio/src/__tests__/theme-store.test.ts`          | unit+integ  | Theme mode switching, localStorage persist (UT-4,5,INT-4) |
| `apps/studio/src/__tests__/docs-bundle-analysis.test.ts` | unit        | Bundle size isolation (UT-8)                              |
| `apps/studio/e2e/studio-theme-docs.spec.ts`              | e2e         | Full docs navigation + access control + theme (E2E-1–8)   |

---

## 11. Configuration

### Environment Variables

| Variable               | Default            | Description                                             |
| ---------------------- | ------------------ | ------------------------------------------------------- |
| `DOCS_ALLOWED_DOMAINS` | `kore.ai,kore.com` | Comma-separated email domains allowed to access `/docs` |

### Runtime Configuration

- Theme mode stored in `localStorage('kore-theme-storage')` — not server-side config
- Docs config (`docs.config.json`) defines sections and navigation structure — checked into repo
- No feature flags — the `/docs` route always exists but returns 404 for non-allowed users

### DSL / Agent IR / Schema

N/A — No DSL or agent IR changes.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Project isolation | N/A — docs are not project-scoped                                                                                  |
| Tenant isolation  | N/A — docs content is the same for all users; access is by email domain, not tenant                                |
| User isolation    | Email-domain gating ensures only allowed users can access docs. Non-allowed users receive 404 (no existence leak). |

### Security & Compliance

- **Auth**: Uses Studio's existing `requireAuth()` — no custom token verification, no independent OAuth flow
- **Access control**: Server-side email-domain check before rendering any docs content
- **No PII**: Docs are static MDX content with no user data, no PII collection
- **Audit**: Standard Studio access logging applies — no additional audit trail needed for read-only docs
- **Secrets**: `DOCS_ALLOWED_DOMAINS` is not a secret (domain names are public), but treated as config

### Performance & Scalability

- **Bundle size**: Zero impact on non-docs routes due to Next.js route-based code splitting
- **Mermaid**: ~200KB lazy-loaded only when a diagram is present on the current page
- **MDX rendering**: Server-side via RSC — no client JS for content body
- **Filesystem reads**: `gray-matter` parses frontmatter on each request; acceptable for static content. Can add caching later if needed.
- **No database queries**: Docs content is entirely filesystem-based

### Reliability & Failure Modes

- **Missing content file**: Return 404 for the specific slug — don't crash the app
- **Malformed frontmatter**: `gray-matter` handles gracefully; render with defaults
- **Mermaid render failure**: Show fallback code block (existing behavior in `Mermaid.tsx`)
- **Env var missing**: Falls back to hardcoded default `kore.ai,kore.com`

### Observability

- No new trace events, metrics, or dashboards — this is a static content feature
- Standard Next.js request logging covers `/docs` routes
- Theme changes are client-side only — no server observability needed

### Data Lifecycle

- **Theme preference**: Lives in localStorage indefinitely; cleared on browser data clear
- **MDX content**: Static files in the repo; lifecycle managed by git
- **No TTLs, retention, or deletion cascades**

---

## 13. Delivery Plan / Work Breakdown

1. **Theme system cleanup**
   1.1 Remove `<ThemeToggle />` from `AppShell.tsx:306` and its import
   1.2 Add theme selector section in `UserMenu.tsx` with System/Light/Dark MenuItems using `Monitor`/`Sun`/`Moon` icons and `Check` for active
   1.3 Update `theme-store.ts` default from `'system'` (already is `'system'`) — verify `THEME_INIT_SCRIPT` fallback
   1.4 Verify `ThemeToggle.tsx` has no other consumers; leave file in place (avoid export deletion in feature commit)

2. **Docs access control**
   2.1 Create `apps/studio/src/lib/docs/access.ts` — email domain extraction and allowlist check against `DOCS_ALLOWED_DOMAINS` env var
   2.2 Add "Docs" MenuItem in `UserMenu.tsx` (conditional on domain check, `BookOpen` icon)
   2.3 Add docs access gate in `/docs` layout (server-side domain check, 404 for non-allowed)

3. **Docs content pipeline**
   3.1 Copy `apps/docs-internal/content/` → `apps/studio/content/`
   3.2 Create `apps/studio/src/lib/docs/content.ts` (migrated from docs-internal, adapted paths)
   3.3 Create `apps/studio/src/lib/docs/config.ts` with `docs.config.json`
   3.4 Add `@tailwindcss/typography` to Studio's dev dependencies
   3.5 Add `next-mdx-remote`, `gray-matter`, `remark-gfm`, `mermaid` to Studio's dependencies
   3.6 Update `next.config.mjs` — add `outputFileTracingIncludes` for `content/` directory

4. **Docs UI components**
   4.1 Create `apps/studio/src/components/docs/DocsSidebar.tsx` (migrated + adapted to use Studio tokens)
   4.2 Migrate MDX components: `Callout`, `Mermaid`, `Milestone`, `index.tsx` (CustomPre/CustomCode)
   4.3 Drop unused components: `FeatureMatrix`, `Reference` (zero usage in content)
   4.4 Replace any hardcoded colors (`bg-gray-100`) with semantic tokens

5. **Docs routing**
   5.1 Create `/docs/page.tsx` — redirect to `/docs/getting-started`
   5.2 Create `/docs/layout.tsx` — access gate + DocsSidebar + prose wrapper
   5.3 Create `/docs/[...slug]/page.tsx` — catch-all MDX renderer with `next-mdx-remote/rsc`

6. **Cleanup & verification**
   6.1 Add prose typography overrides scoped to docs content area
   6.2 Verify standalone build includes `content/` directory
   6.3 Verify non-allowed users see 404 on `/docs/*`
   6.4 Verify theme switching works on docs pages
   6.5 Update Turbo build config if needed

---

## 14. Success Metrics

| Metric                               | Baseline          | Target           | How Measured                        |
| ------------------------------------ | ----------------- | ---------------- | ----------------------------------- |
| Separate apps to deploy              | 2 (Studio + docs) | 1 (Studio only)  | Count of Dockerfiles / PM2 services |
| Theme modes accessible to users      | 2 (light/dark)    | 3 (system/l/d)   | UI inspection                       |
| Studio bundle size (non-docs routes) | Current           | No increase      | `next build` output analysis        |
| Docs page load time                  | N/A (no deploy)   | < 2s first load  | Browser devtools                    |
| Non-allowed user sees docs content   | N/A               | 0 (404 returned) | E2E test                            |

---

## 15. Open Questions

1. Should the `apps/docs-internal/` directory be removed in the same PR or a follow-up? (Recommendation: follow-up, to keep the feature commit additive)
2. Should docs content be cached in memory after first filesystem read to avoid repeated `gray-matter` parsing? (Likely yes for production, but not needed for MVP)
3. Should the docs sidebar collapse on mobile, or should docs be desktop-only initially?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                              | Severity | Status |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | No search functionality within docs — users must navigate via sidebar                                                                                                                                                                    | Medium   | Open   |
| GAP-002 | `TableOfContents` component exists in docs-internal but is not wired into the page route                                                                                                                                                 | Low      | Open   |
| GAP-003 | `sidebar.json` (static nav) in docs-internal is stale — migration uses `docs.config.json` + filesystem scanning only                                                                                                                     | Low      | Open   |
| GAP-004 | `FeatureMatrix` and `Reference` MDX components have zero JSX invocations (`<FeatureMatrix>`, `<Reference>`) in content MDX files — text references exist in prose but the components are never rendered as React elements. Not migrated. | Low      | Open   |
| GAP-005 | `llms.txt` public asset in docs-internal not migrated (unclear if still needed)                                                                                                                                                          | Low      | Open   |

---

## 17. Testing & Validation

**Full Test Spec**: [`docs/testing/ancillary/studio-theme-docs-integration.md`](../../testing/ancillary/studio-theme-docs-integration.md)

### Summary

| Type        | Count | Status     |
| ----------- | ----- | ---------- |
| E2E         | 8     | NOT TESTED |
| Integration | 11    | NOT TESTED |
| Unit        | 8     | NOT TESTED |
| Security    | 10    | NOT TESTED |
| Performance | 5     | NOT TESTED |

### Required Test Coverage

| #   | Scenario                                             | Coverage Type | Status     | Test File / Note                           |
| --- | ---------------------------------------------------- | ------------- | ---------- | ------------------------------------------ |
| 1   | Theme selector shows System/Light/Dark in UserMenu   | e2e           | NOT TESTED | E2E-1                                      |
| 2   | Theme default is system for new user                 | unit          | NOT TESTED | UT-4                                       |
| 3   | Theme persists across page reload                    | e2e           | NOT TESTED | E2E-3                                      |
| 4   | Allowed-domain user can access /docs                 | e2e           | NOT TESTED | E2E-4, E2E-5                               |
| 5   | Non-allowed user gets 404 on /docs                   | e2e           | NOT TESTED | E2E-6                                      |
| 6   | Docs link hidden in UserMenu for non-allowed users   | e2e           | NOT TESTED | E2E-6                                      |
| 7   | MDX content renders with correct frontmatter         | integration   | NOT TESTED | INT-1, INT-3                               |
| 8   | Mermaid diagrams render lazily                       | e2e           | NOT TESTED | E2E-7                                      |
| 9   | Docs pages use Studio theme tokens (dark mode works) | e2e           | NOT TESTED | E2E-8                                      |
| 10  | Non-docs Studio routes have no bundle size increase  | unit          | NOT TESTED | UT-8                                       |
| 11  | ThemeToggle no longer rendered in AppShell header    | e2e           | NOT TESTED | E2E-1                                      |
| 12  | Hardcoded palette colors replaced in MDX components  | integration   | NOT TESTED | INT-5,6,7,9                                |
| 12  | Migrated MDX components use semantic tokens only     | integration   | NOT TESTED | CSS class verification on all 5 components |

### Testing Notes

Theme switching is primarily a client-side feature testable via browser automation. Docs access control is server-side and testable via HTTP requests with different auth contexts. Bundle size impact should be verified via build output comparison.

> Full testing details: `../../testing/ancillary/studio-theme-docs-integration.md`

---

## 18. References

- Design docs: `docs/superpowers/specs/2026-03-16-docs-internal-design.md` (standalone design — superseded by this spec)
- Related feature docs: [Agent Dev Studio](agent-development-studio.md), [SSO / Enterprise Auth](sso-enterprise-auth.md), [Gradient Design Tokens](gradient-design-tokens.md)
- Existing code: `apps/studio/src/store/theme-store.ts`, `apps/studio/src/components/ui/ThemeToggle.tsx`, `apps/docs-internal/`
