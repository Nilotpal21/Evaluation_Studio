# Test Specification: Studio Theme System & Internal Docs Integration

**Feature Spec**: `docs/features/ancillary/studio-theme-docs-integration.md`
**HLD**: N/A (not yet generated)
**LLD**: N/A (not yet generated)
**Status**: PLANNED
**Last Updated**: 2026-03-25

---

## 1. Coverage Matrix

| FR    | Description                                            | Unit | Integration | E2E | Manual | Status     |
| ----- | ------------------------------------------------------ | ---- | ----------- | --- | ------ | ---------- |
| FR-1  | Remove ThemeToggle from AppShell header                |      |             | REQ |        | NOT TESTED |
| FR-2  | Theme selector in UserMenu (System/Light/Dark)         |      |             | REQ |        | NOT TESTED |
| FR-3  | Default theme mode is system                           | REQ  |             |     |        | NOT TESTED |
| FR-4  | Theme persists to localStorage, applied before paint   | REQ  | REQ         | REQ |        | NOT TESTED |
| FR-5  | MDX docs at /docs/[...slug] via next-mdx-remote/rsc    |      | REQ         | REQ |        | NOT TESTED |
| FR-6  | Content from filesystem with gray-matter               |      | REQ         |     |        | NOT TESTED |
| FR-7  | Email domain access gate (DOCS_ALLOWED_DOMAINS)        | REQ  |             | REQ |        | NOT TESTED |
| FR-8  | 404 for non-allowed users (not 403)                    |      |             | REQ |        | NOT TESTED |
| FR-9  | Docs link conditional in UserMenu                      |      |             | REQ |        | NOT TESTED |
| FR-10 | Code-split docs dependencies                           | REQ  |             |     |        | NOT TESTED |
| FR-11 | Mermaid lazy loaded per-diagram                        |      |             | REQ |        | NOT TESTED |
| FR-12 | Studio semantic tokens in docs                         |      | REQ         |     | REQ    | NOT TESTED |
| FR-13 | Hardcoded palette colors replaced with semantic tokens |      | REQ         |     |        | NOT TESTED |

---

## 2. E2E Test Scenarios (MANDATORY)

**Test Infrastructure**: Playwright against running Studio instance (localhost:5173).
**Auth**: Dev Login API (`/api/auth/dev-login`) with configurable email for domain testing.
**File**: `apps/studio/e2e/studio-theme-docs.spec.ts`

CRITICAL: E2E tests must exercise the real system through its HTTP API.
No mocks, no direct DB access, no stubbed servers.

### E2E-1: Theme selector visible in UserMenu, ThemeToggle absent from header

- **Preconditions**: Authenticated Studio user via Dev Login (`developer@kore.ai`)
- **Steps**:
  1. Navigate to `GET /` — wait for Studio to load
  2. Assert no element matching `[title="Switch to light mode"], [title="Switch to dark mode"]` exists in the header bar (ThemeToggle removed per FR-1)
  3. Click the user avatar button in the header to open UserMenu
  4. Assert three theme menu items are visible: text "System", "Light", "Dark" with icons (`Monitor`, `Sun`, `Moon`)
  5. Assert one of them has a checkmark indicator (`Check` icon) showing the active mode
- **Expected Result**: ThemeToggle icon absent from header. UserMenu shows System/Light/Dark with active checkmark.
- **Auth Context**: `developer@kore.ai` — authenticated via Dev Login, Studio session cookie
- **FRs Covered**: FR-1, FR-2

### E2E-2: Theme switching via UserMenu changes data-theme attribute

- **Preconditions**: Authenticated user, UserMenu open
- **Steps**:
  1. Open UserMenu, click "Dark" menu item
  2. Assert `document.documentElement.getAttribute('data-theme')` === `'dark'`
  3. Assert checkmark moves to "Dark" item (reopen menu to verify)
  4. Open UserMenu, click "Light" menu item
  5. Assert `document.documentElement.getAttribute('data-theme')` === `'light'`
  6. Assert checkmark moves to "Light" item
  7. Open UserMenu, click "System" menu item
  8. Assert `data-theme` resolves to OS preference (via `prefers-color-scheme` media query)
- **Expected Result**: Each click immediately switches theme. Checkmark follows active selection.
- **Auth Context**: `developer@kore.ai` — authenticated via Dev Login, Studio session cookie
- **FRs Covered**: FR-2, FR-3

### E2E-3: Theme persists across page reload (no FOUC)

- **Preconditions**: Authenticated user
- **Steps**:
  1. Open UserMenu, select "Dark" theme
  2. Verify `data-theme="dark"` is set
  3. `page.reload()` — reload the page
  4. Immediately check `data-theme` attribute via `page.evaluate(() => document.documentElement.getAttribute('data-theme'))` — must be `'dark'` before React hydration
  5. After page loads, open UserMenu — verify "Dark" has checkmark
  6. Set localStorage to invalid JSON: `page.evaluate(() => localStorage.setItem('kore-theme-storage', '{invalid}'))`
  7. `page.reload()` — reload the page
  8. Assert `data-theme` falls back to `'light'` (THEME_INIT_SCRIPT catch block)
  9. Set localStorage to valid JSON with missing mode: `page.evaluate(() => localStorage.setItem('kore-theme-storage', '{"state":{}}'))`
  10. `page.reload()` — reload the page
  11. Assert `data-theme` resolves to OS preference (the `'system'` fallback path in THEME_INIT_SCRIPT: `(s.state&&s.state.mode)||'system'`)
- **Expected Result**: Theme persists via localStorage. THEME_INIT_SCRIPT applies theme before first paint. Invalid JSON falls back to `'light'`. Valid JSON with missing mode falls back to `'system'` (OS preference).
- **Auth Context**: `developer@kore.ai` — authenticated via Dev Login, Studio session cookie
- **FRs Covered**: FR-4

### E2E-4: Allowed-domain user sees Docs link and can access /docs

- **Preconditions**: Authenticated user with `developer@kore.ai` email (allowed domain)
- **Steps**:
  1. Open UserMenu
  2. Assert a "Docs" menu item with `BookOpen` icon is visible
  3. Click "Docs" — verify navigation to `/docs/getting-started`
  4. Assert docs sidebar renders with section titles (e.g., "Getting Started", "Tutorials", "Guides")
  5. Assert main content area renders MDX content with a heading
  6. Click a different section link in sidebar (e.g., "Architecture")
  7. Assert URL changes to `/docs/architecture` and content updates
  8. Click a subsection page link
  9. Assert URL changes to `/docs/architecture/<slug>` and content renders
- **Expected Result**: Docs fully accessible. Sidebar navigation works across sections.
- **Auth Context**: `developer@kore.ai` — allowed domain, authenticated via Dev Login + Studio session cookie
- **Isolation Check**: Content renders using Studio's current theme tokens
- **FRs Covered**: FR-5, FR-9

### E2E-5: Second allowed domain (kore.com) can access /docs

- **Preconditions**: Dev Login with `tester@kore.com` email
- **Steps**:
  1. Login via Dev Login API: `page.request.post('/api/auth/dev-login', { data: { email: 'tester@kore.com', name: 'Kore Tester' } })`
  2. Navigate to `/docs/getting-started`
  3. Assert HTTP 200 response
  4. Assert docs content renders (heading visible)
- **Expected Result**: Second domain in comma-separated `DOCS_ALLOWED_DOMAINS` also grants access.
- **Auth Context**: `tester@kore.com` — second allowed domain
- **FRs Covered**: FR-7

### E2E-6: Non-allowed domain user gets 404, no Docs link visible

- **Preconditions**: Dev Login with `external@gmail.com` email
- **Steps**:
  1. Login via Dev Login API: `page.request.post('/api/auth/dev-login', { data: { email: 'external@gmail.com', name: 'External User' } })`
  2. Handle auth callback to get session token
  3. Open UserMenu — assert "Docs" menu item is NOT present
  4. Navigate directly to `/docs/getting-started`
  5. Assert page shows 404 / "not found" content (NOT 403, NOT a "contact admin" message)
  6. Navigate to `/docs/architecture/system-overview`
  7. Assert same 404 behavior — no docs content leaked
- **Expected Result**: No Docs link in menu. All /docs/\* routes return 404. No existence leak.
- **Auth Context**: `external@gmail.com` — non-allowed domain, authenticated via Dev Login
- **Isolation Check**: Cross-scope access returns 404 per platform invariant #1
- **FRs Covered**: FR-7, FR-8, FR-9

### E2E-7: Mermaid diagrams render as SVG, lazy-loaded

- **Preconditions**: Allowed-domain user authenticated
- **Steps**:
  1. Navigate to a docs page known to contain mermaid code blocks (e.g., `/docs/architecture/system-overview`)
  2. Wait for mermaid SVG: `page.locator('.mermaid svg, [data-mermaid] svg').waitFor({ state: 'visible', timeout: 15000 })`
  3. Assert SVG element exists within the mermaid container — not raw code text
  4. Navigate to a docs page WITHOUT mermaid (e.g., `/docs/getting-started`)
  5. Assert no mermaid-related network requests were made for this page (check `page.route('**/mermaid**')` or performance entries)
- **Expected Result**: Pages with mermaid show rendered SVG diagrams. Pages without mermaid don't load the library.
- **Auth Context**: `developer@kore.ai`
- **FRs Covered**: FR-11

### E2E-8: Docs pages respect Studio theme (dark and light)

- **Preconditions**: Allowed-domain user on a docs page
- **Steps**:
  1. Navigate to `/docs/getting-started`
  2. Set theme to "Dark" via UserMenu
  3. Assert `data-theme="dark"` on `<html>`
  4. Assert the docs page background uses dark theme colors: `page.evaluate(() => getComputedStyle(document.body).backgroundColor)` — should be a dark value (near black)
  5. Set theme to "Light" via UserMenu
  6. Assert docs page background uses light theme colors — should be a light value (near white/gray)
- **Expected Result**: Docs pages inherit Studio's active theme. No flash, no separate theme.
- **Auth Context**: `developer@kore.ai`
- **FRs Covered**: FR-12

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: Content loader parses frontmatter from real MDX files

- **Boundary**: Filesystem → `content.ts` (gray-matter) → `DocPage` object
- **Setup**: Real MDX fixture files in a test `content/` directory with known frontmatter (`title`, `description`, `section`, `order`)
- **Steps**:
  1. Call `getDocPage('test-section', 'test-page')` with fixture directory
  2. Assert returned object has `title`, `description`, `section`, `order` matching fixture frontmatter
  3. Assert `content` field contains the MDX body (without frontmatter)
- **Expected Result**: Frontmatter parsed correctly, content body extracted
- **Failure Mode**: Malformed frontmatter → gray-matter handles gracefully, returns defaults
- **File**: `apps/studio/src/__tests__/docs-content.test.ts`
- **FRs Covered**: FR-6

### INT-2: Content loader returns null for missing MDX file

- **Boundary**: Filesystem → `content.ts`
- **Setup**: Request a non-existent section/slug combination
- **Steps**:
  1. Call `getDocPage('nonexistent-section', 'missing-page')`
  2. Assert returns `null` (not throws)
- **Expected Result**: Graceful null return for missing content
- **Failure Mode**: Function throws instead of returning null → route handler would crash instead of showing 404
- **File**: `apps/studio/src/__tests__/docs-content.test.ts`
- **FRs Covered**: FR-6

### INT-3: getAllSections returns sections with pages from filesystem

- **Boundary**: Filesystem + `docs.config.json` → `content.ts` + `config.ts` → `SectionWithPages[]`
- **Setup**: Real fixture content directory with multiple sections and MDX files
- **Steps**:
  1. Call `getAllSections()` with fixture content directory
  2. Assert returned array has sections matching `docs.config.json` entries that have corresponding content files
  3. Assert each section has `pages` array with correct `title`, `slug`, `order` from frontmatter
  4. Assert pages within a section are sorted by `order`
- **Expected Result**: Sections loaded from config, populated with filesystem pages, sorted correctly
- **File**: `apps/studio/src/__tests__/docs-content.test.ts`
- **FRs Covered**: FR-5, FR-6

### INT-4: Theme store rehydrates from localStorage on fresh mount

- **Boundary**: localStorage → Zustand `persist` middleware → `theme-store.ts` state
- **Setup**: Set `localStorage.setItem('kore-theme-storage', JSON.stringify({ state: { mode: 'dark' }, version: 0 }))`
- **Steps**:
  1. Import and access the theme store after localStorage is seeded
  2. Trigger rehydration via the `onRehydrateStorage` callback
  3. Assert `store.mode === 'dark'` and `store.resolved === 'dark'`
  4. Assert `document.documentElement.getAttribute('data-theme') === 'dark'`
- **Expected Result**: Store rehydrates from localStorage and applies theme to DOM
- **Failure Mode**: Persist middleware misconfigured → theme resets to default on every page load
- **File**: `apps/studio/src/__tests__/theme-store.test.ts`
- **FRs Covered**: FR-4

### INT-5: Callout component renders with semantic tokens, not hardcoded palette

- **Boundary**: MDX custom component → rendered HTML → CSS classes
- **Setup**: Render `<Callout type="info">Info text</Callout>`, `<Callout type="warning">Warn</Callout>`, `<Callout type="tip">Tip</Callout>` using testing-library
- **Steps**:
  1. Render each Callout variant
  2. Get the rendered wrapper element's className
  3. Assert NO hardcoded palette classes present: `bg-blue-50`, `border-blue-200`, `text-blue-900`, `bg-amber-50`, `bg-green-50`
  4. Assert semantic token classes ARE present (e.g., classes using `bg-info-subtle`, `bg-warning-subtle`, `bg-success-subtle` or equivalent via CSS custom properties)
- **Expected Result**: All Callout variants use semantic design tokens
- **File**: `apps/studio/src/__tests__/docs-mdx-components.test.ts`
- **FRs Covered**: FR-13

### INT-6: CustomPre and CustomCode render with semantic tokens

- **Boundary**: MDX custom component → rendered HTML → CSS classes
- **Setup**: Render `<CustomPre>` with a code block and `<CustomCode>` with inline code
- **Steps**:
  1. Render `CustomPre` wrapping a `<code>` element
  2. Assert no hardcoded classes: `bg-gray-900`, `text-gray-100`
  3. Assert semantic token usage (e.g., `bg-background-muted`, `text-foreground`)
  4. Render `CustomCode` with inline text
  5. Assert no hardcoded classes: `text-pink-600`, `bg-gray-100`
  6. Assert semantic token usage
- **Expected Result**: Code rendering components use semantic design tokens
- **File**: `apps/studio/src/__tests__/docs-mdx-components.test.ts`
- **FRs Covered**: FR-13

### INT-7: Milestone component renders with semantic tokens

- **Boundary**: MDX custom component → rendered HTML → CSS classes
- **Setup**: Render `<Milestone>` with done/in-progress/planned items
- **Steps**:
  1. Render Milestone with items of each status
  2. Assert no hardcoded classes: `bg-blue-500`, `bg-gray-400`, `text-slate-700`, `bg-slate-100`
  3. Assert semantic token usage for status indicators
- **Expected Result**: Milestone timeline uses semantic design tokens for all states
- **File**: `apps/studio/src/__tests__/docs-mdx-components.test.ts`
- **FRs Covered**: FR-13

### INT-8: Docs access gate + content loader pipeline (module-level)

- **Boundary**: `checkDomainAllowed()` → `getDocPage()` → MDX source string (in-process, no HTTP)
- **Setup**: Import access gate and content loader functions directly. Fixture MDX content directory.
- **Steps**:
  1. Call `checkDomainAllowed('developer@kore.ai', ['kore.ai', 'kore.com'])` — assert `true`
  2. Call `getDocPage('getting-started', 'index')` with fixture content directory
  3. Assert returned object has non-null `content` and valid `title` from frontmatter
  4. Call `checkDomainAllowed('external@gmail.com', ['kore.ai', 'kore.com'])` — assert `false`
  5. Verify the two functions compose correctly: if access check fails, content is never loaded (no filesystem read)
- **Expected Result**: Access gate and content loader integrate correctly as a pipeline — gate before load
- **Failure Mode**: Content loader called before access check → unauthorized users trigger filesystem reads (performance leak)
- **File**: `apps/studio/src/__tests__/docs-content.test.ts`
- **FRs Covered**: FR-5, FR-7

### INT-9: Mermaid component renders with semantic tokens, not hardcoded palette

- **Boundary**: MDX custom component → rendered HTML → CSS classes
- **Setup**: Render `<Mermaid chart="graph TD; A-->B" />` using testing-library. Component renders a loading state before mermaid initializes.
- **Steps**:
  1. Render Mermaid component with a simple chart definition
  2. Get the loading placeholder element's className
  3. Assert NO hardcoded palette class: `bg-gray-100`
  4. Assert semantic token class is used instead (e.g., `bg-background-muted` or equivalent CSS custom property)
  5. After mermaid renders, verify the SVG container also uses semantic tokens
- **Expected Result**: Mermaid loading placeholder and container use semantic design tokens
- **File**: `apps/studio/src/__tests__/docs-mdx-components.test.ts`
- **FRs Covered**: FR-13

### INT-10: Content loader handles malformed frontmatter gracefully

- **Boundary**: Filesystem → `content.ts` (gray-matter) → `DocPage` object
- **Setup**: Fixture MDX file with malformed YAML frontmatter (e.g., `---\ntitle: [invalid yaml\n---\nContent body here`)
- **Steps**:
  1. Call `getDocPage('test-section', 'malformed-frontmatter')` with fixture directory containing the malformed file
  2. Assert function returns a document object (not null, does not throw)
  3. Assert `content` field contains the body text
  4. Assert metadata fields (`title`, `description`) are either empty strings or sensible defaults — not the raw malformed YAML
- **Expected Result**: gray-matter handles malformed frontmatter gracefully. Content still extractable.
- **Failure Mode**: Function throws an unhandled parse error → route handler crashes with 500 instead of rendering with defaults
- **File**: `apps/studio/src/__tests__/docs-content.test.ts`
- **FRs Covered**: FR-6

### INT-11: Mermaid render failure shows fallback code block

- **Boundary**: Mermaid component → `mermaid.render()` → fallback UI
- **Setup**: Render `<Mermaid chart="graph INVALID;;;" />` with invalid chart syntax using testing-library
- **Steps**:
  1. Render Mermaid component with syntactically invalid chart definition
  2. Wait for mermaid render attempt to complete (or timeout)
  3. Assert no SVG element is rendered
  4. Assert a `<pre>` or `<code>` fallback block is visible containing the raw chart text
  5. Assert no uncaught error propagates (component boundary catches the failure)
- **Expected Result**: Invalid mermaid syntax renders a code block fallback, not a crash or blank area
- **Failure Mode**: Unhandled mermaid error propagates → React error boundary or blank page
- **HLD Note**: The current `Mermaid.tsx` also lacks a `.catch()` on the dynamic `import('mermaid')` promise. If the chunk fails to load (network error), the component shows the loading placeholder indefinitely. HLD should address adding error handling on the import itself — that path cannot be tested at integration level without mocking the import.
- **File**: `apps/studio/src/__tests__/docs-mdx-components.test.ts`
- **FRs Covered**: FR-11

---

## 4. Unit Test Scenarios

### UT-1: Domain allowlist check — allowed domains

- **Module**: `apps/studio/src/lib/docs/access.ts`
- **Input**: `checkDomainAllowed('user@kore.ai', ['kore.ai', 'kore.com'])`
- **Expected Output**: `true`
- **Additional cases**: `user@kore.com` → true, `user@KORE.AI` → true (case-insensitive), `user@sub.kore.ai` → false (exact match, not subdomain)
- **FRs Covered**: FR-7

### UT-2: Domain allowlist check — non-allowed domains

- **Module**: `apps/studio/src/lib/docs/access.ts`
- **Input**: `checkDomainAllowed('user@gmail.com', ['kore.ai', 'kore.com'])`
- **Expected Output**: `false`
- **Additional cases**: `user@kore.ai.evil.com` → false, `user@notakore.ai` → false, `''` → false, `'nodomain'` → false
- **FRs Covered**: FR-7

### UT-3: Domain allowlist — env var parsing

- **Module**: `apps/studio/src/lib/docs/access.ts`
- **Input**: `DOCS_ALLOWED_DOMAINS=' kore.ai , kore.com '` (with spaces)
- **Expected Output**: Parses to `['kore.ai', 'kore.com']` (trimmed)
- **Additional cases**: empty string → fallback to `['kore.ai', 'kore.com']`, undefined → fallback, single domain → `['acme.com']`
- **FRs Covered**: FR-7

### UT-4: Theme store defaults to system mode

- **Module**: `apps/studio/src/store/theme-store.ts`
- **Input**: Fresh store with no localStorage
- **Expected Output**: `mode === 'system'`, `resolved` matches `prefers-color-scheme`
- **FRs Covered**: FR-3

### UT-5: Theme store setMode applies all three modes correctly

- **Module**: `apps/studio/src/store/theme-store.ts`
- **Input**: `setMode('light')`, `setMode('dark')`, `setMode('system')`
- **Expected Output**: Each sets correct `mode` and `resolved`, applies `data-theme` to document
- **FRs Covered**: FR-2

### UT-6: Docs config loader parses valid config

- **Module**: `apps/studio/src/lib/docs/config.ts`
- **Input**: Valid `docs.config.json` with sections array
- **Expected Output**: `getDocsConfig()` returns `DocsConfig` with `sections`, `siteName`
- **FRs Covered**: FR-5

### UT-7: Docs config loader handles missing/malformed config

- **Module**: `apps/studio/src/lib/docs/config.ts`
- **Input**: Missing file, malformed JSON
- **Expected Output**: Returns sensible defaults or throws with clear error
- **FRs Covered**: FR-5

### UT-8: Bundle analysis — docs chunks not in main entry

- **Module**: Build output analysis
- **Input**: `.next/build-manifest.json` after `next build`
- **Expected Output**: Chunks containing `next-mdx-remote`, `gray-matter`, `remark-gfm`, `mermaid` are NOT present in entry chunks for non-docs routes (e.g., `/`, `/projects/[projectId]`)
- **FRs Covered**: FR-10

---

## 5. Security & Isolation Tests

| #    | Scenario                                                   | Auth Context         | Expected               | FR   |
| ---- | ---------------------------------------------------------- | -------------------- | ---------------------- | ---- |
| S-1  | Non-allowed email navigates to /docs/getting-started       | `external@gmail.com` | 404                    | FR-8 |
| S-2  | Non-allowed email navigates to /docs/architecture/system   | `external@gmail.com` | 404                    | FR-8 |
| S-3  | Non-allowed email navigates to /docs (root)                | `external@gmail.com` | 404                    | FR-8 |
| S-4  | Unauthenticated request to /docs/getting-started           | None                 | Redirect to login      | FR-7 |
| S-5  | Allowed email with trailing spaces in env var              | `user@kore.ai`       | 200 (trimmed)          | FR-7 |
| S-6  | Empty DOCS_ALLOWED_DOMAINS env var                         | `user@kore.ai`       | 200 (fallback used)    | FR-7 |
| S-7  | Case-insensitive domain check                              | `user@KORE.AI`       | 200                    | FR-7 |
| S-8  | Subdomain not matching (user@sub.kore.ai)                  | `user@sub.kore.ai`   | 404                    | FR-7 |
| S-9  | 404 response does NOT contain docs content or sidebar HTML | `external@gmail.com` | No docs markup in body | FR-8 |
| S-10 | "Docs" menu item absent for non-allowed users              | `external@gmail.com` | Not in DOM             | FR-9 |

---

## 6. Performance & Load Tests

| #   | Scenario                             | Metric                        | Target              | How Measured                               |
| --- | ------------------------------------ | ----------------------------- | ------------------- | ------------------------------------------ |
| P-1 | Non-docs route bundle size           | JS bytes for `/` route        | No increase vs base | `next build` output, build-manifest.json   |
| P-2 | Docs page without mermaid            | Mermaid chunk not requested   | 0 mermaid requests  | Playwright network interceptor             |
| P-3 | Docs page with mermaid               | Time to SVG render            | < 3s                | Playwright `waitFor` timing                |
| P-4 | Docs page initial load (first visit) | LCP                           | < 2s                | Playwright performance API                 |
| P-5 | Theme switch latency                 | Time from click to data-theme | < 100ms             | Playwright timing between click and assert |

---

## 7. Test Infrastructure

### Required Services

- **Studio**: Running on `localhost:5173` (dev mode for E2E) or built for bundle analysis
- **No external services**: No database, no Runtime, no SearchAI — docs is filesystem-only, theme is client-only

### Data Seeding

- **MDX fixture files**: `apps/studio/src/__tests__/fixtures/docs-content/` (to be created during implementation) — small set of test MDX files with known frontmatter for content loader unit/integration tests
- **docs.config.json fixture**: Test config with 2-3 sections for config loader tests
- **No database seeding**: Feature has no database dependencies

### Environment Variables

| Variable               | Test Value         | Purpose                              |
| ---------------------- | ------------------ | ------------------------------------ |
| `DOCS_ALLOWED_DOMAINS` | `kore.ai,kore.com` | Default allowlist for positive tests |
| `DOCS_ALLOWED_DOMAINS` | `acme.com`         | Custom allowlist for override tests  |
| `DOCS_ALLOWED_DOMAINS` | `` (empty)         | Fallback behavior test               |
| `ENABLE_DEV_LOGIN`     | `true`             | Required for Playwright Dev Login    |

### CI Configuration

- **Unit tests**: Run via `pnpm test --filter=@agent-platform/studio` (Vitest)
- **E2E tests**: Run via `pnpm exec playwright test apps/studio/e2e/studio-theme-docs.spec.ts` (requires running Studio)
- **Bundle analysis**: Run `pnpm build --filter=@agent-platform/studio` then parse build output
- **Browser engine**: E2E tests require Chromium (Playwright default) for reliable `getComputedStyle` assertions in E2E-3, E2E-7, E2E-8

---

## 8. Test File Mapping

| Test File                                                | Type        | Covers                                       |
| -------------------------------------------------------- | ----------- | -------------------------------------------- |
| `apps/studio/src/__tests__/docs-access.test.ts`          | unit        | FR-7 (UT-1, UT-2, UT-3)                      |
| `apps/studio/src/__tests__/docs-content.test.ts`         | unit+integ  | FR-5,6,7 (INT-1,2,3,8,10)                    |
| `apps/studio/src/__tests__/docs-config.test.ts`          | unit        | FR-5 (UT-6, UT-7)                            |
| `apps/studio/src/__tests__/docs-mdx-components.test.ts`  | integration | FR-11,13 (INT-5,6,7,9,11)                    |
| `apps/studio/src/__tests__/theme-store.test.ts`          | unit+integ  | FR-2,3,4 (UT-4,5, INT-4)                     |
| `apps/studio/src/__tests__/docs-bundle-analysis.test.ts` | unit        | FR-10 (UT-8)                                 |
| `apps/studio/e2e/studio-theme-docs.spec.ts`              | e2e         | FR-1,2,4,5,7,8,9,11,12 (E2E-1 through E2E-8) |

---

## 9. Open Testing Questions

1. Should the Playwright E2E tests be split into two files (`studio-theme.spec.ts` and `studio-docs.spec.ts`) or kept as one? One file keeps the feature cohesive; two files allow parallel execution.
2. For the bundle analysis test (UT-8), should it run as part of the regular test suite or as a separate CI step? It requires `next build` which is slow.
3. The Dev Login API with arbitrary emails — does it create a user record in the DB for non-existent emails? If so, E2E tests with `external@gmail.com` may need cleanup.
4. Should there be a visual regression test (screenshot comparison) for docs pages in both light and dark themes? The gradient-tokens spec has a precedent for this pattern.
