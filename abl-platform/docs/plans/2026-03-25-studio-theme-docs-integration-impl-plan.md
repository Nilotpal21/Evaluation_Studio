# LLD: Studio Theme System & Internal Docs Integration

**Feature Spec**: `docs/features/ancillary/studio-theme-docs-integration.md`
**HLD**: Skipped (user decision — small feature, no new services/data models)
**Test Spec**: `docs/testing/ancillary/studio-theme-docs-integration.md`
**Status**: DRAFT
**Date**: 2026-03-25

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                              | Rationale                                                                                                                                                                                                   | Alternatives Rejected                                                                                                 |
| ---- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| D-1  | Theme first, docs second                                              | Commit discipline (one concern per commit). Docs pages verify theme works.                                                                                                                                  | Interleaved — harder to bisect                                                                                        |
| D-2  | Route group `(internal)` for MDX docs                                 | Existing `/docs/abl` and `/docs/agent-anatomy` pages must not be wrapped by access gate layout. Route group isolates the layout.                                                                            | Shared `/docs/layout.tsx` — breaks existing pages. Move existing pages — unnecessary churn.                           |
| D-3  | Layout-level access gate (server component)                           | No middleware.ts exists in Studio. Layout runs server-side before render. Returns `notFound()` for denied users.                                                                                            | Middleware — disproportionate for one feature. Client-only — leaks HTML source.                                       |
| D-4  | Preserve `toggle()` and `ThemeToggle.tsx` file                        | CLAUDE.md: "feature commits must be additive." `toggle()` has test consumers.                                                                                                                               | Delete ThemeToggle.tsx — violates export removal guard                                                                |
| D-5  | Async `content.ts` and `config.ts`                                    | CLAUDE.md: "No sync I/O." docs-internal uses `readFileSync` — fix during migration.                                                                                                                         | Copy sync pattern — violates rules                                                                                    |
| D-6  | Fix Mermaid `.catch()` during migration                               | No-swallowed-catches rule. Natural time since we're already editing the file.                                                                                                                               | Defer — leaves known bug in migrated code                                                                             |
| D-7  | Content at `apps/studio/content/` (app root)                          | Read server-side via `fs.promises`, not imported by bundler. Matches docs-internal pattern.                                                                                                                 | `src/content/` — mixes compiled/non-compiled. `public/` — publicly served.                                            |
| D-8  | `@tailwindcss/typography` for prose styling                           | Standard Tailwind approach for MDX content rendering. Scoped to `.docs-prose` wrapper in docs layout.                                                                                                       | Custom CSS — reinvents the wheel                                                                                      |
| D-9  | Internal API route `/api/docs/access` for server-side auth            | Studio's refresh_token is opaque (crypto.randomBytes), not a JWT — cannot be decoded in layout. API route resolves token via DB lookup and returns `{ email, allowed }`.                                    | Decode refresh_token directly — impossible (not JWT). Add user_email cookie — less secure. Middleware — no precedent. |
| D-10 | `NEXT_PUBLIC_DOCS_ALLOWED_DOMAINS` env var prefix                     | UserMenu is a client component (`'use client'`). Client components only see `NEXT_PUBLIC_*` env vars. Domain names are not secrets.                                                                         | Server-only env var — invisible to client components. Server prop drilling — over-complicated.                        |
| D-11 | Extend MenuItem with `end` prop for Check icon                        | Workspace switcher uses custom inline JSX, not MenuItem. Adding an `end?: ReactNode` prop to MenuItem keeps the API clean for theme items.                                                                  | Custom inline JSX — duplicates pattern, harder to maintain.                                                           |
| D-12 | Code block tokens: fixed dark background via `.docs-code-block` class | `bg-background-inverse` / `text-foreground-inverse` don't exist in design system. Code blocks are conventionally dark regardless of theme. Define `.docs-code-block` in globals.css with fixed dark values. | Aspirational token names — don't exist, would need design system changes.                                             |

### Key Interfaces & Types

```typescript
// apps/studio/src/lib/docs/access.ts
export function checkDomainAllowed(email: string, allowedDomains: string[]): boolean;
export function getAllowedDomains(): string[];

// apps/studio/src/app/api/docs/access/route.ts (internal API for server-side auth)
// GET /api/docs/access — reads refresh_token cookie, resolves user via DB, returns domain check
// Response: { success: true, data: { email: string; allowed: boolean } }
// Error: { success: false, error: { code: string; message: string } } with 401 status

// apps/studio/src/lib/docs/config.ts
export interface DocsConfig {
  siteName: string;
  sections: Array<{ slug: string; title: string }>;
}
export async function getDocsConfig(): Promise<DocsConfig>;

// apps/studio/src/lib/docs/content.ts
export interface DocPage {
  slug: string;
  title: string;
  description: string;
  section: string;
  order: number;
  content: string;
}
export interface SectionWithPages {
  slug: string;
  title: string;
  pages: DocPage[];
}
export async function getDocPage(section: string, slug: string): Promise<DocPage | null>;
export async function getSectionPages(sectionSlug: string): Promise<DocPage[]>;
export async function getAllSections(): Promise<SectionWithPages[]>;
```

### Module Boundaries

| Module                                   | Responsibility                                                 | Depends On                                                    |
| ---------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| `lib/docs/access.ts`                     | Email domain allowlist check + env var parsing                 | None (pure functions)                                         |
| `lib/docs/config.ts`                     | Read `docs.config.json`, return section list                   | `fs.promises`, `docs.config.json`                             |
| `lib/docs/content.ts`                    | Load MDX files from `content/`, parse frontmatter              | `gray-matter`, `fs.promises`, `config.ts`                     |
| `components/docs/DocsSidebar.tsx`        | Section navigation sidebar (client component)                  | `lib/docs/config.ts` (data passed as props)                   |
| `components/docs/mdx/*.tsx`              | MDX custom components with semantic tokens                     | `@agent-platform/design-tokens` via CSS                       |
| `app/api/docs/access/route.ts`           | Server-side auth: resolve refresh_token → email → domain check | `lib/docs/access.ts`, auth DB (via existing auth service)     |
| `app/docs/(internal)/layout.tsx`         | Access gate + prose wrapper + sidebar                          | `/api/docs/access` (internal fetch), `lib/docs/config.ts`     |
| `app/docs/(internal)/[...slug]/page.tsx` | MDX renderer (RSC)                                             | `next-mdx-remote/rsc`, `lib/docs/content.ts`, `mdx/index.tsx` |

---

## 2. File-Level Change Map

### New Files

| File                                                     | Purpose                                                | LOC Est. |
| -------------------------------------------------------- | ------------------------------------------------------ | -------- |
| `apps/studio/src/lib/docs/access.ts`                     | Domain allowlist check + env parsing                   | ~30      |
| `apps/studio/src/lib/docs/config.ts`                     | Async docs config loader                               | ~25      |
| `apps/studio/src/lib/docs/content.ts`                    | MDX content loader (gray-matter + fs)                  | ~80      |
| `apps/studio/docs.config.json`                           | Section navigation config (copied from docs-internal)  | ~25      |
| `apps/studio/content/**/*.mdx`                           | 74 MDX files (copied from docs-internal)               | ~N/A     |
| `apps/studio/src/app/api/docs/access/route.ts`           | Server-side auth: token → email → domain check         | ~40      |
| `apps/studio/src/app/docs/(internal)/layout.tsx`         | Access gate + DocsSidebar + prose wrapper              | ~60      |
| `apps/studio/src/app/docs/(internal)/[...slug]/page.tsx` | Catch-all MDX renderer (RSC)                           | ~50      |
| `apps/studio/src/app/docs/(internal)/page.tsx`           | Redirect to /docs/getting-started                      | ~10      |
| `apps/studio/src/components/docs/DocsSidebar.tsx`        | Section navigation sidebar                             | ~80      |
| `apps/studio/src/components/docs/mdx/Callout.tsx`        | Info/warning/tip callout (semantic tokens)             | ~35      |
| `apps/studio/src/components/docs/mdx/Mermaid.tsx`        | Lazy mermaid renderer (semantic tokens + .catch())     | ~40      |
| `apps/studio/src/components/docs/mdx/Milestone.tsx`      | Timeline milestone (semantic tokens)                   | ~40      |
| `apps/studio/src/components/docs/mdx/index.tsx`          | Component map + CustomPre/CustomCode (semantic tokens) | ~50      |
| `apps/studio/src/__tests__/docs-access.test.ts`          | Unit tests for domain allowlist                        | ~60      |
| `apps/studio/src/__tests__/docs-content.test.ts`         | Unit + integration tests for content loader            | ~100     |
| `apps/studio/src/__tests__/docs-config.test.ts`          | Unit tests for config loader                           | ~40      |
| `apps/studio/src/__tests__/docs-mdx-components.test.ts`  | Integration tests for semantic tokens                  | ~120     |
| `apps/studio/src/__tests__/fixtures/docs-content/`       | Fixture MDX files for tests                            | ~N/A     |
| `apps/studio/e2e/studio-theme-docs.spec.ts`              | E2E tests (Playwright)                                 | ~250     |

### Modified Files

| File                                                 | Change Description                                                                             | Risk |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---- |
| `apps/studio/src/components/navigation/AppShell.tsx` | Remove `<ThemeToggle />` (line 306) and its import (line 29)                                   | Low  |
| `apps/studio/src/components/auth/UserMenu.tsx`       | Add theme selector section + conditional Docs link                                             | Med  |
| `apps/studio/next.config.mjs`                        | Add `outputFileTracingIncludes` for content, add `gray-matter` to `serverExternalPackages`     | Low  |
| `apps/studio/package.json`                           | Add deps: `gray-matter`, `next-mdx-remote`, `remark-gfm`, `mermaid`, `@tailwindcss/typography` | Low  |
| `apps/studio/src/app/globals.css`                    | Add scoped `.prose` typography overrides for docs content area                                 | Low  |

### Deleted Files

None. Feature commits must be additive. `ThemeToggle.tsx` stays in place.

---

## 3. Implementation Phases

CRITICAL: Each phase must be independently deployable and testable.
No phase should leave the system in a broken state.

### Phase 1: Theme System — UserMenu Integration

**Goal**: Replace header ThemeToggle icon with a three-option theme selector in UserMenu dropdown.

**Tasks**:

1.1. Read `UserMenu.tsx` — identify insertion point between existing menu items and logout divider. Note the `MenuItem` component pattern (icon, label, onClick) and workspace switcher `Check` icon pattern.

1.2. Extend `MenuItem` component in `UserMenu.tsx` to accept an optional `end` prop:

- Add `end?: React.ReactNode` to the MenuItem inline type object (lines 290-295)
- Render `{end && <span className="shrink-0">{end}</span>}` after the shortcut span (around line 308) in the MenuItem function body, right-aligned

  1.3. Add theme selector section to `UserMenu.tsx`:

- Import `Monitor`, `Sun`, `Moon`, `Check` from `lucide-react`
- Import `useThemeStore` from `../../store/theme-store`
- Add i18n keys: use `useTranslations('user_menu')` (already imported) with keys `theme_system`, `theme_light`, `theme_dark`
- Add a new `<div className="py-1 border-t border-default">` section before the logout divider
- Render three MenuItem items: System (Monitor icon), Light (Sun icon), Dark (Moon icon)
- Active mode gets `end={<Check className="w-3.5 h-3.5 shrink-0 text-accent" />}` (matching workspace switcher pattern at line 220)
- Each item calls `setMode('system' | 'light' | 'dark')`

  1.4. Add i18n keys to `packages/i18n/locales/en/studio.json`:

- `user_menu.theme_system`: "System"
- `user_menu.theme_light`: "Light"
- `user_menu.theme_dark`: "Dark"

  1.5. Remove `<ThemeToggle />` from `AppShell.tsx`:

- Remove import at line 29: `import { ThemeToggle } from '../ui/ThemeToggle';`
- Remove JSX at line 308: `<ThemeToggle />`

  1.6. Verify build: `pnpm build --filter=@agent-platform/studio`

**Files Touched**:

- `apps/studio/src/components/auth/UserMenu.tsx` — extend MenuItem with `end` prop, add theme section
- `apps/studio/src/components/navigation/AppShell.tsx` — remove ThemeToggle import + JSX
- `packages/i18n/locales/en/studio.json` — add theme label keys

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/studio` passes with 0 type errors
- [ ] No `ThemeToggle` in AppShell header (grep confirms no JSX usage)
- [ ] UserMenu shows System/Light/Dark with correct icons
- [ ] Active theme has Check indicator
- [ ] Each option changes `data-theme` attribute on `<html>`
- [ ] `ThemeToggle.tsx` file still exists (not deleted)

**Test Strategy**:

- Manual verification via dev server (theme switching in UserMenu)
- Existing `remaining-stores.test.ts` theme tests still pass

**Rollback**: Revert the single commit. ThemeToggle.tsx is still in place.

---

### Phase 2: Docs Access Library + Configuration

**Goal**: Create the domain allowlist library, config loader, and add conditional Docs link to UserMenu.

**Tasks**:

2.1. Create `apps/studio/src/lib/docs/access.ts`:

```typescript
// checkDomainAllowed(email, domains) → boolean
// - Extract domain after @, compare case-insensitively
// - Exact match only (no subdomain matching)
// getAllowedDomains() → string[]
// - Parse NEXT_PUBLIC_DOCS_ALLOWED_DOMAINS env var (comma-separated, trimmed)
// - Fallback to ['kore.ai', 'kore.com'] if empty/missing
// NOTE: Uses NEXT_PUBLIC_ prefix because UserMenu is a client component
// and needs access to the domains list. Domain names are not secrets.
```

2.2. Create `apps/studio/src/lib/docs/config.ts`:

```typescript
// getDocsConfig() → Promise<DocsConfig>
// - Read docs.config.json via fs.promises.readFile (ASYNC, not sync)
// - NO caching — file is ~1KB, read-per-request is negligible
// - Return { siteName, sections: [{ slug, title }] }
```

2.3. Copy `apps/docs-internal/docs.config.json` → `apps/studio/docs.config.json`. Remove `allowedDomains` field (that's in env var, not config).

2.4. Add conditional "Docs" link to `UserMenu.tsx`:

- Import `BookOpen` from `lucide-react`
- Read user email from auth store (`useAuthStore().user?.email`)
- Call `checkDomainAllowed(email, getAllowedDomains())`
- If allowed, render `<MenuItem icon={<BookOpen />} label={t('docs')} onClick={() => { window.location.href = '/docs'; }} />`
- Place above the theme section
- **Note**: Uses `window.location.href` (not `useNavigationStore.navigate()`) because `/docs` routes are server-rendered RSC pages, not client SPA routes. A full page navigation is needed to execute the RSC layout access gate. Alternatively, wrap in an `<a href="/docs">` anchor element.

  2.5. Add i18n key to `packages/i18n/locales/en/studio.json`:

- `user_menu.docs`: "Docs"

  2.6. Create unit tests `apps/studio/src/__tests__/docs-access.test.ts`:

- UT-1: allowed domains return true
- UT-2: non-allowed domains return false
- UT-3: env var parsing with spaces, fallback

  2.7. Create unit tests `apps/studio/src/__tests__/docs-config.test.ts`:

- UT-6: valid config parsing
- UT-7: missing/malformed config

  2.8. Verify build: `pnpm build --filter=@agent-platform/studio`

**Files Touched**:

- `apps/studio/src/lib/docs/access.ts` — new
- `apps/studio/src/lib/docs/config.ts` — new
- `apps/studio/docs.config.json` — new (copied + modified)
- `apps/studio/src/components/auth/UserMenu.tsx` — add Docs link
- `packages/i18n/locales/en/studio.json` — add `user_menu.docs` key
- `apps/studio/src/__tests__/docs-access.test.ts` — new
- `apps/studio/src/__tests__/docs-config.test.ts` — new
- `apps/studio/src/__tests__/fixtures/docs-content/` — test fixtures

**Exit Criteria**:

- [ ] `checkDomainAllowed('user@kore.ai', ['kore.ai'])` returns `true`
- [ ] `checkDomainAllowed('user@gmail.com', ['kore.ai'])` returns `false`
- [ ] `checkDomainAllowed('user@KORE.AI', ['kore.ai'])` returns `true` (case-insensitive)
- [ ] `checkDomainAllowed('user@sub.kore.ai', ['kore.ai'])` returns `false` (no subdomain)
- [ ] All unit tests pass: `pnpm test --filter=@agent-platform/studio -- docs-access`
- [ ] All unit tests pass: `pnpm test --filter=@agent-platform/studio -- docs-config`
- [ ] Docs link visible in UserMenu for allowed-domain user
- [ ] Docs link NOT visible for non-allowed user
- [ ] `pnpm build --filter=@agent-platform/studio` passes

**Test Strategy**:

- Unit: `docs-access.test.ts` (UT-1, UT-2, UT-3), `docs-config.test.ts` (UT-6, UT-7)
- Manual: Dev Login with different emails to verify Docs link visibility

**Rollback**: Revert commit. UserMenu Docs link is purely additive.

---

### Phase 3: Docs Content Pipeline + MDX Components

**Goal**: Migrate content files, create content loader, and migrate MDX components with semantic tokens.

This phase has two commits to respect the 40-file limit:

- **3a**: Content files + config (docs commit — MDX files are documentation)
- **3b**: Content loader + MDX components (feat commit — code files)

**Tasks (3a — content copy)**:

3a.1. Copy entire `apps/docs-internal/content/` directory → `apps/studio/content/`

- All 74 MDX files across 16 sections
- Preserve directory structure exactly

3a.2. Verify no content files reference absolute paths or docs-internal-specific imports.

3a.3. Commit message: `[ABLP-2] docs(studio): copy 74 MDX content files from docs-internal`. Note: `.mdx` files are documentation and exempt from the 40-file non-doc limit in the commit scope guard.

**Tasks (3b — code)**:

3b.1. Add `gray-matter` to `apps/studio/package.json` dependencies. Run `pnpm install`.

3b.2. Create `apps/studio/src/lib/docs/content.ts`:

```typescript
// getContentDir() → string
// - Uses path.join(process.cwd(), 'content') — works in both dev and standalone
// - NOTE: __dirname is NOT available in ESM (Next.js uses ESM modules).
//   Do NOT use __dirname as a fallback. process.cwd() is correct for Next.js
//   standalone builds (cwd is set to the .next/standalone/apps/studio directory).
// - Phase 6 MUST verify this path works in standalone build output
// getDocPage(section, slug) → Promise<DocPage | null>
//   - Read file via fs.promises.readFile
//   - Parse frontmatter via gray-matter
//   - Return null for missing files (try/catch ENOENT)
//   - Handle malformed frontmatter gracefully (return defaults)
// getSectionPages(sectionSlug) → Promise<DocPage[]>
//   - Read directory, filter .mdx, parse each, sort by order
// getAllSections() → Promise<SectionWithPages[]>
//   - Read config sections, populate each with pages from filesystem
```

3b.3. Create `apps/studio/src/components/docs/mdx/Callout.tsx`:

- Migrate from `apps/docs-internal/src/components/mdx/Callout.tsx`
- Replace hardcoded colors with semantic tokens:
  - `bg-blue-50` → `bg-info-subtle` (or `bg-accent-subtle`)
  - `border-blue-200` → `border-info/30` (use opacity modifier for subtle border)
  - `text-blue-900` → `text-foreground`
  - `text-blue-500` → `text-info` (or `text-accent`)
  - `bg-amber-50` → `bg-warning-subtle`
  - `border-amber-200` → `border-warning/30`
  - `text-amber-900` → `text-foreground`
  - `text-amber-500` → `text-warning`
  - `bg-green-50` → `bg-success-subtle`
  - `border-green-200` → `border-success/30`
  - `text-green-900` → `text-foreground`
  - `text-green-500` → `text-success`
- **Note**: Border tokens at full opacity may be too bold. Use `/30` opacity modifier (e.g., `border-info/30`) for a subtle effect matching the original `border-blue-200`.

3b.4. Create `apps/studio/src/components/docs/mdx/Mermaid.tsx`:

- Migrate from `apps/docs-internal/src/components/mdx/Mermaid.tsx`
- `'use client'` directive (uses `useEffect`, `useState`, `useRef`)
- Replace `bg-gray-100` → `bg-background-muted` (loading placeholder)
- Add `.catch()` on BOTH `import('mermaid')` AND `mermaid.render()`:
  ```typescript
  import('mermaid')
    .then((m) => {
      m.default.initialize({ theme: resolvedTheme === 'dark' ? 'dark' : 'neutral' });
      return m.default.render(id, chart);
    })
    .then(({ svg }) => setSvg(svg))
    .catch(() => setError(true));
  ```
- Add error state: render `<pre>` fallback with raw chart text when `error === true`
- This single `.catch()` at the end of the chain handles both import failures (network error) and render failures (invalid syntax)
- Use `useThemeStore` resolved theme to set Mermaid's `theme` config (`dark` vs `neutral`)

3b.5. Create `apps/studio/src/components/docs/mdx/Milestone.tsx`:

- Migrate from `apps/docs-internal/src/components/mdx/Milestone.tsx`
- Replace hardcoded colors:
  - `bg-green-500` → `bg-success`
  - `bg-blue-500` → `bg-accent`
  - `bg-gray-400` → `bg-muted`
  - `text-slate-700` → `text-foreground`
  - `text-slate-900` → `text-foreground`
  - `text-slate-500` → `text-subtle` (planned status — least emphasis, lighter)
  - `bg-slate-200` → `bg-background-muted` (timeline connector line — verify `bg-[hsl(var(--border))]` if a border-color background is needed)
  - `bg-slate-100` → `bg-background-muted`
  - `text-slate-600` → `text-muted` (date badge — secondary info, slightly darker than subtle)

3b.6. Create `apps/studio/src/components/docs/mdx/index.tsx`:

- Migrate CustomPre and CustomCode from `apps/docs-internal/src/components/mdx/index.tsx`
- Replace hardcoded colors:
  - `bg-gray-900` → use `.docs-code-block` class (fixed dark background defined in globals.css — code blocks are always dark)
  - `text-gray-100` → use `.docs-code-block` class (fixed light text on dark background)
  - `bg-gray-100` → `bg-background-muted`
  - `text-pink-600` → `text-accent`
- **Note**: `bg-background-inverse` and `text-foreground-inverse` do NOT exist in the design system. Instead, define a `.docs-code-block` class in `globals.css` with fixed dark values that work in both themes (code blocks conventionally have dark backgrounds).
- Export `mdxComponents` map (Callout, Mermaid, Milestone, pre: CustomPre, code: CustomCode)
- Do NOT include FeatureMatrix or Reference (zero usage in content)

3b.7. Create content loader integration tests `apps/studio/src/__tests__/docs-content.test.ts`:

- INT-1: Frontmatter parsing from real MDX fixture
- INT-2: Missing file returns null
- INT-3: getAllSections returns sorted pages
- INT-8: Access gate + content loader pipeline (module-level)
- INT-10: Malformed frontmatter graceful handling

3b.8. Create MDX component integration tests `apps/studio/src/__tests__/docs-mdx-components.test.ts`:

- INT-5: Callout semantic tokens (no hardcoded palette)
- INT-6: CustomPre/CustomCode semantic tokens
- INT-7: Milestone semantic tokens
- INT-9: Mermaid semantic tokens (bg-gray-100 absent)
- INT-11: Mermaid render failure → fallback code block

3b.9. Create test fixtures in `apps/studio/src/__tests__/fixtures/docs-content/`:

- `test-section/test-page.mdx` — valid frontmatter
- `test-section/malformed-frontmatter.mdx` — invalid YAML
- `docs.config.json` — test config with 2 sections

3b.10. Verify build: `pnpm build --filter=@agent-platform/studio`

**Files Touched (3a)**: `apps/studio/content/**/*.mdx` (74 files)
**Files Touched (3b)**: ~12 code files (content.ts, 4 MDX components, 2 test files, 3 fixtures, package.json)

**Exit Criteria**:

- [ ] 74 MDX files exist under `apps/studio/content/`
- [ ] `getDocPage('getting-started', 'index')` returns valid DocPage with content
- [ ] `getDocPage('nonexistent', 'missing')` returns `null`
- [ ] `getAllSections()` returns 16 sections with pages sorted by order
- [ ] All Callout variants render without `bg-blue-50`, `bg-amber-50`, `bg-green-50` classes
- [ ] CustomPre renders without `bg-gray-900` class
- [ ] Mermaid loading state renders without `bg-gray-100` class
- [ ] Mermaid with invalid syntax shows `<pre>` fallback (not crash)
- [ ] Milestone renders without `bg-blue-500`, `bg-gray-400`, `text-slate-700` classes
- [ ] Integration tests pass: `pnpm test --filter=@agent-platform/studio -- docs-content`
- [ ] Integration tests pass: `pnpm test --filter=@agent-platform/studio -- docs-mdx`
- [ ] `pnpm build --filter=@agent-platform/studio` passes

**Test Strategy**:

- Integration: `docs-content.test.ts` (INT-1,2,3,8,10), `docs-mdx-components.test.ts` (INT-5,6,7,9,11)
- Fixtures: Real MDX files with known frontmatter

**Rollback**: Revert both commits (3a + 3b). Content files are additive, no existing files modified.

---

### Phase 4: Docs Routing + Layout

**Goal**: Wire up Next.js routing for `/docs` with access gate, sidebar, and MDX rendering.

**Tasks**:

4.1. Add remaining dependencies to `apps/studio/package.json`:

- `next-mdx-remote` to dependencies
- `remark-gfm` to dependencies
- `mermaid` to dependencies
- `@tailwindcss/typography` to devDependencies
- Run `pnpm install`

  4.2. Create `apps/studio/src/app/api/docs/access/route.ts`:

```typescript
// GET /api/docs/access — internal API for server-side auth check (read-only)
// 1. Read refresh_token from cookies (httpOnly cookie set during login)
// 2. Hash the token: hashToken(refreshToken) using SHA-256 (import from token-hash utility)
// 3. Look up token record: findRefreshToken(hashedToken) — READ-ONLY DB query
//    CRITICAL: Do NOT call refreshTokens() from auth-service — that ROTATES
//    the token and would invalidate the user's session on every docs page load.
//    Use the read-only findRefreshToken() lookup path ONLY.
// 4. Verify: tokenRecord exists, tokenRecord.revokedAt is null, not expired
// 5. Look up user: findUserById(tokenRecord.userId) to get user.email
// 6. Call checkDomainAllowed(email, getAllowedDomains())
// 7. Return platform envelope: { success: true, data: { email, allowed: boolean } }
// 8. If no valid refresh token or lookup fails → return { success: false, error: { code: 'UNAUTHORIZED', message: '...' } } with 401 status
```

4.3. Create `apps/studio/src/app/docs/(internal)/layout.tsx`:

```typescript
// React Server Component
// 1. Read cookies via next/headers
// 2. Call internal API: fetch('http://localhost:${PORT}/api/docs/access', { headers: { cookie } })
//    OR use direct DB lookup if Studio has a server-side auth utility
// 3. Parse response envelope: const { data } = await res.json()
//    If data.allowed === false → notFound() (returns 404)
// 4. If 401 (no auth) → redirect to /auth/login
// 5. Fetch sections via getAllSections() for sidebar
// 6. Render: <div className="flex"><DocsSidebar sections={sections} /><main className="docs-prose">{children}</main></div>
```

**Note**: The `(internal)` route group ensures this layout ONLY wraps MDX docs routes. Existing `/docs/abl` and `/docs/agent-anatomy` are NOT affected.

4.4. Create `apps/studio/src/app/docs/(internal)/page.tsx`:

```typescript
// Redirect to /docs/getting-started
import { redirect } from 'next/navigation';
export default function DocsRootPage() {
  redirect('/docs/getting-started');
}
```

4.5. Create `apps/studio/src/app/docs/(internal)/[...slug]/page.tsx`:

```typescript
// React Server Component
// 1. Parse slug: slug[0] = section, slug[1] = page (or 'index')
//    For single-segment URLs like /docs/faq: section='faq', page='index'
//    Slug resolution: try {section}/{page}.mdx first, then {section}/index.mdx,
//    then first .mdx file in section directory (handles sections like faq/faq.mdx)
// 2. Call getDocPage(section, page) — content.ts handles the fallback chain
// 3. If null → notFound()
// 4. Render MDX: <MDXRemote source={doc.content} components={mdxComponents} options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }} />
// 5. generateMetadata() for page title from frontmatter
```

4.6. Create `apps/studio/src/components/docs/DocsSidebar.tsx`:

```typescript
// Client component ('use client')
// Props: { sections: SectionWithPages[] }
// Renders collapsible section list with active page highlight
// Uses semantic tokens: bg-background-elevated, text-foreground, etc.
// Links use next/link for client-side navigation
```

4.7. Add prose typography overrides and code block class to `apps/studio/src/app/globals.css`:

- Scoped to `.docs-prose` class (not global `.prose`)
- Override heading, link, code, table styles to use semantic tokens
- Keep overrides minimal — `@tailwindcss/typography` handles most styling
- Add `.docs-code-block` class with fixed dark background/light text for code blocks (works in both themes)

  4.8. Register `@tailwindcss/typography` plugin in `apps/studio/tailwind.config.js`:

- Add `import typography from '@tailwindcss/typography'` at the top (ESM import — NOT `require()`)
- Add `typography` to the `plugins: [...]` array in the config object
- Do NOT modify `packages/tailwind-config/base.js` — keep the plugin Studio-scoped
- **CRITICAL**: Just installing the package is NOT enough — the plugin MUST be registered in the config file. Without this, `.prose` classes have no effect.

  4.9. Update `apps/studio/next.config.mjs`:

- Add to `outputFileTracingIncludes` (verify existing key pattern — the config already has entries, follow the same format):

  ```js
  '/docs': ['./content/**/*', './docs.config.json'],
  ```

- Add `gray-matter` to `serverExternalPackages` array (it uses Node.js `fs` — must be externalized for server-side bundling)

  4.10. Verify build and routing:

- `pnpm build --filter=@agent-platform/studio`
- Dev server: navigate to `/docs/getting-started` with allowed-domain user
- Dev server: navigate to `/docs/abl` — verify existing page still works
- Dev server: navigate to `/docs` with non-allowed user — verify 404

**Files Touched**:

- `apps/studio/src/app/api/docs/access/route.ts` — new (server-side auth check)
- `apps/studio/src/app/docs/(internal)/layout.tsx` — new
- `apps/studio/src/app/docs/(internal)/page.tsx` — new
- `apps/studio/src/app/docs/(internal)/[...slug]/page.tsx` — new
- `apps/studio/src/components/docs/DocsSidebar.tsx` — new
- `apps/studio/src/app/globals.css` — add scoped prose overrides + `.docs-code-block` class
- `apps/studio/next.config.mjs` — add outputFileTracingIncludes + `gray-matter` to serverExternalPackages
- `apps/studio/tailwind.config.js` — register `@tailwindcss/typography` plugin via ESM import
- `apps/studio/package.json` — add dependencies

**Exit Criteria**:

- [ ] `/docs/getting-started` renders MDX content for allowed-domain user
- [ ] `/docs/architecture` renders MDX content with sidebar navigation
- [ ] `/docs` redirects to `/docs/getting-started`
- [ ] `/docs/getting-started` returns 404 for non-allowed-domain user
- [ ] `/docs/abl` still renders existing ABL docs page (no access gate)
- [ ] `/docs/agent-anatomy` still renders existing page (no access gate)
- [ ] Mermaid diagrams render as SVG on pages with mermaid content
- [ ] Pages without mermaid don't load the mermaid chunk (network tab)
- [ ] Docs pages respect Studio theme (dark/light backgrounds change)
- [ ] `next build` output shows docs chunks separate from main entry
- [ ] `pnpm build --filter=@agent-platform/studio` passes

**Test Strategy**:

- Manual: Full navigation flow, theme switching on docs pages, access control
- Build verification: Bundle analysis, standalone output includes content

**Rollback**: Revert commit. All files are new except `globals.css` (additive CSS), `next.config.mjs` (one line), and `package.json` (dependency additions).

---

### Phase 5: E2E + Remaining Tests

**Goal**: Implement all E2E test scenarios from the test spec plus any remaining integration/unit tests.

**Tasks**:

5.1. Create `apps/studio/e2e/studio-theme-docs.spec.ts`:

- E2E-1: Theme selector visible in UserMenu, ThemeToggle absent
- E2E-2: Theme switching changes data-theme attribute
- E2E-3: Theme persists across reload (no FOUC) + both fallback paths
- E2E-4: Allowed-domain user sees Docs link and can access /docs
- E2E-5: Second allowed domain (kore.com) access
- E2E-6: Non-allowed domain gets 404, no Docs link
- E2E-7: Mermaid renders as SVG, lazy-loaded
- E2E-8: Docs pages respect Studio theme

  5.2. Add INT-4 (theme rehydration from localStorage) to `apps/studio/src/__tests__/remaining-stores.test.ts`:

- INT-4: Theme rehydration from localStorage — new test
- Note: UT-4 (default mode is system) and UT-5 (setMode all three modes) are already covered by existing tests in this file (lines 72-113)

  5.3. Create `apps/studio/src/__tests__/docs-bundle-analysis.test.ts`:

- UT-8: Docs chunks not in main entry (requires build output)

  5.4. Verify all tests pass:

- `pnpm test --filter=@agent-platform/studio`
- `pnpm exec playwright test apps/studio/e2e/studio-theme-docs.spec.ts`

**Files Touched**:

- `apps/studio/e2e/studio-theme-docs.spec.ts` — new
- `apps/studio/src/__tests__/remaining-stores.test.ts` — modified (add theme tests)
- `apps/studio/src/__tests__/docs-bundle-analysis.test.ts` — new

**Exit Criteria**:

- [ ] All 8 E2E scenarios pass in Playwright
- [ ] All unit tests pass: `pnpm test --filter=@agent-platform/studio`
- [ ] Security scenarios verified:
  - S-1 (non-allowed domain → 404): E2E-6
  - S-2 (no auth → redirect login): E2E layout access gate
  - S-3 (email case insensitivity): UT-1 via `checkDomainAllowed`
  - S-4 (subdomain rejection): UT-2 via `checkDomainAllowed`
  - S-5 (no email in token): API route 401 path
  - S-6 (expired token): API route token verification
  - S-7 (revoked token): API route `revokedAt` check
  - S-8 (domain list injection): UT-3 env var parsing
  - S-9 (path traversal in slug): INT-2 / `getDocPage` file resolution
  - S-10 (XSS via MDX content): `next-mdx-remote` sanitization (built-in)
- [ ] No regressions in existing test suite

**Test Strategy**:

- E2E: Playwright against running Studio, Dev Login with configurable email
- Unit: Vitest for bundle analysis, theme store

**Rollback**: Revert commit. Tests are additive — no production code changes.

---

### Phase 6: Verification + Build Validation

**Goal**: Final verification of standalone build, bundle impact, and all acceptance criteria.

**Tasks**:

6.1. Run `pnpm build --filter=@agent-platform/studio` and verify:

- Standalone output includes `content/` directory
- Standalone output includes `docs.config.json`
- No docs-related chunks in non-docs route manifests

  6.2. Run full test suite: `pnpm build && pnpm test`

- Verify zero regressions across all packages

  6.3. Run prettier on all changed files: `npx prettier --write <all-changed-files>`

  6.4. Verify performance targets:

- P-1: Non-docs route bundle size — no increase
- P-2: Docs page without mermaid — 0 mermaid network requests
- P-5: Theme switch latency — < 100ms

  6.5. Run `/post-impl-sync studio-theme-docs-integration` to update all docs

**Exit Criteria**:

- [ ] `pnpm build` succeeds for entire monorepo
- [ ] `pnpm test` passes for entire monorepo (zero regressions)
- [ ] Bundle analysis confirms no size increase for non-docs routes
- [ ] All files formatted with prettier
- [ ] Feature spec, test spec, and LLD status updated

**Rollback**: N/A — verification phase makes no code changes.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.

- [ ] Theme selector section wired into `UserMenu.tsx` (Phase 1, task 1.2)
- [ ] ThemeToggle removed from `AppShell.tsx` header (Phase 1, task 1.3)
- [ ] Docs link wired into `UserMenu.tsx` with domain check (Phase 2, task 2.4)
- [ ] `docs.config.json` placed at `apps/studio/docs.config.json` (Phase 2, task 2.3)
- [ ] `content/` directory at `apps/studio/content/` (Phase 3a)
- [ ] `mdxComponents` map exported from `mdx/index.tsx` (Phase 3b, task 3b.6)
- [ ] `mdxComponents` imported in `[...slug]/page.tsx` and passed to `MDXRemote` (Phase 4, task 4.4)
- [ ] `DocsSidebar` imported in `(internal)/layout.tsx` (Phase 4, task 4.2)
- [ ] `/api/docs/access` route created and resolves refresh_token → email → domain check (Phase 4, task 4.2)
- [ ] `(internal)/layout.tsx` calls `/api/docs/access` for server-side gate (Phase 4, task 4.3)
- [ ] i18n keys added for theme labels and Docs link (Phase 1, task 1.4; Phase 2, task 2.5)
- [ ] `getDocPage` called in `[...slug]/page.tsx` (Phase 4, task 4.4)
- [ ] `getAllSections` called in `(internal)/layout.tsx` for sidebar data (Phase 4, task 4.2)
- [ ] `outputFileTracingIncludes` updated in `next.config.mjs` (Phase 4, task 4.9)
- [ ] `gray-matter` added to `serverExternalPackages` in `next.config.mjs` (Phase 4, task 4.9)
- [ ] Dependencies added to `package.json`: `gray-matter` (Phase 3b), `next-mdx-remote` + `remark-gfm` + `mermaid` + `@tailwindcss/typography` (Phase 4)
- [ ] `@tailwindcss/typography` registered in `apps/studio/tailwind.config.js` plugins array via ESM import (Phase 4, task 4.8) — CRITICAL: installation alone is insufficient
- [ ] Prose CSS overrides added to `globals.css` (Phase 4, task 4.7)
- [ ] E2E test file registered in Playwright config (Phase 5) — note: `playwright.config.ts` uses `testDir: './e2e'` which auto-discovers `.spec.ts` files

---

## 5. Cross-Phase Concerns

### Route Collision Mitigation

The `(internal)` route group is the key architectural decision:

```
apps/studio/src/app/docs/
  abl/page.tsx                    ← EXISTING (unchanged, no access gate)
  agent-anatomy/page.tsx          ← EXISTING (unchanged, no access gate)
  (internal)/
    layout.tsx                    ← NEW (access gate applies ONLY here)
    page.tsx                      ← NEW (redirect to /docs/getting-started)
    [...slug]/page.tsx            ← NEW (MDX renderer)
```

Next.js resolution:

- `/docs/abl` → static match → `docs/abl/page.tsx` (no layout gate)
- `/docs/getting-started` → dynamic match → `docs/(internal)/[...slug]/page.tsx` (layout gate applies)
- `/docs` → `docs/(internal)/page.tsx` → redirect

### Configuration Changes

| Variable                           | Default            | Added In                                     |
| ---------------------------------- | ------------------ | -------------------------------------------- |
| `NEXT_PUBLIC_DOCS_ALLOWED_DOMAINS` | `kore.ai,kore.com` | Phase 2 (access.ts reads it, client-visible) |

No new runtime config, database migrations, or feature flags.

### Semantic Token Mapping

All hardcoded Tailwind palette colors → Studio semantic tokens. Before implementing, **READ `apps/studio/src/app/globals.css`** to verify the exact token names available in `[data-theme='light']` and `:root` (dark).

If specific semantic tokens (e.g., `bg-info-subtle`, `bg-warning-subtle`, `bg-success-subtle`) don't exist in the design system, create them in `globals.css` scoped to the docs area, or use the closest available token.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] ThemeToggle icon absent from Studio header
- [ ] UserMenu shows System/Light/Dark theme selector with active checkmark
- [ ] Default theme is `system` (respects OS preference)
- [ ] Theme persists across page reload with no FOUC
- [ ] `/docs/getting-started` renders MDX content for `@kore.ai` user
- [ ] `/docs/getting-started` renders MDX content for `@kore.com` user
- [ ] `/docs/getting-started` returns 404 for `@gmail.com` user
- [ ] "Docs" link visible in UserMenu only for allowed-domain users
- [ ] Docs pages inherit Studio theme (dark mode works correctly)
- [ ] Mermaid diagrams render as SVG, lazy-loaded per-diagram
- [ ] Existing `/docs/abl` and `/docs/agent-anatomy` pages unaffected
- [ ] Non-docs routes have zero bundle size increase
- [ ] All 8 E2E test scenarios pass
- [ ] All 11 integration test scenarios pass
- [ ] All 8 unit test scenarios pass
- [ ] `pnpm build && pnpm test` passes with zero regressions
- [ ] Feature spec §17 updated with coverage status

### FR-to-Phase Traceability

FR numbers match the feature spec (`docs/features/ancillary/studio-theme-docs-integration.md` §4).

| FR    | Description                                        | Phase(s) | Tasks                                |
| ----- | -------------------------------------------------- | -------- | ------------------------------------ |
| FR-1  | Remove ThemeToggle from AppShell header            | 1        | 1.5                                  |
| FR-2  | Theme selector in UserMenu (System/Light/Dark)     | 1        | 1.2, 1.3                             |
| FR-3  | Default to `system` mode for new users             | 1        | 1.3 (existing store default)         |
| FR-4  | Persist theme + apply before first paint (no FOUC) | 1, 5     | existing THEME_INIT_SCRIPT, E2E-3    |
| FR-5  | MDX docs at `/docs/[...slug]`                      | 3b, 4    | 3b.2, 4.5                            |
| FR-6  | Content from filesystem (`content/` + gray-matter) | 3a, 3b   | 3a.1, 3b.2                           |
| FR-7  | Email domain access control                        | 2, 4     | 2.1, 4.2                             |
| FR-8  | 404 (not 403) for non-allowed users                | 4        | 4.3                                  |
| FR-9  | Docs MenuItem in UserMenu (domain-gated)           | 2        | 2.4                                  |
| FR-10 | Code-split docs dependencies                       | 4        | 4.9 (outputFileTracingIncludes), 4.5 |
| FR-11 | Mermaid lazy dynamic import per-diagram            | 3b       | 3b.4                                 |
| FR-12 | Use Studio semantic design tokens for docs styling | 3b, 4    | 3b.3–3b.6, 4.7                       |
| FR-13 | Replace hardcoded palette colors in MDX components | 3b       | 3b.3, 3b.4, 3b.5, 3b.6               |

---

## 7. Open Questions

1. ~~**Auth cookie for server-side email extraction**~~ **RESOLVED (D-9)**: Create internal API route `/api/docs/access` that reads the opaque refresh_token cookie, resolves the user via DB lookup (reusing existing auth service), and returns `{ email, allowed }`. The layout calls this route.

2. ~~**Prose typography scope**~~ **RESOLVED**: Use scoped `.docs-prose` class (not global `.prose`). Specified in Phase 4 task 4.7.

3. **Content caching**: `config.ts` — no caching (1KB file, negligible). `content.ts` — defer caching to a follow-up optimization. Read from filesystem per request for now. In production standalone, Next.js RSC caching provides request-level deduplication.

---

## 8. Cross-Phase Discrepancies (for post-impl-sync)

These discrepancies between the LLD and the feature spec / test spec should be resolved during `/post-impl-sync`:

1. **Env var naming**: Feature spec §11 references `DOCS_ALLOWED_DOMAINS`. LLD uses `NEXT_PUBLIC_DOCS_ALLOWED_DOMAINS` (required for client component visibility). Feature spec needs updating.
2. **Test file naming**: Test spec §8 references `theme-store.test.ts`. Actual file is `remaining-stores.test.ts` (which contains theme store tests). Test spec needs updating.
3. **New API route**: `/api/docs/access` was introduced in the LLD (D-9) but is not in the feature spec §7 (Key Implementation Files). Feature spec needs updating.
4. **Default theme mode**: Feature spec says "light" default. LLD uses "system" default (matching existing theme-store code). Feature spec needs updating to match code reality.
