# docs-internal: Internal Documentation App

**Date:** 2026-03-16
**Status:** Approved
**Author:** Prasanna + Claude

## Problem

The agent platform v2 needs internal documentation for both technical and non-technical team members. Content includes migration strategy, product readiness, milestones, feature parity, architecture overviews, and rationale for the new platform. This must be protected behind Google sign-in with domain whitelisting — no public access, no redirect to the main Studio app.

## Decision

Standalone Next.js 16 app (`apps/docs-internal/`) with:

- Google OAuth using shared credentials (same `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` as Studio)
- Domain whitelist in a checked-in config file (`docs.config.json`)
- MDX content authored in `content/` directory with frontmatter-driven navigation
- Lightweight JWT session (no database, no user creation)
- Port 3004

## Architecture

### App Structure

```
apps/docs-internal/
├── src/
│   ├── app/
│   │   ├── layout.tsx              # Root layout (sidebar, header)
│   │   ├── page.tsx                # Redirects to first section
│   │   ├── auth/
│   │   │   └── signin/page.tsx     # Branded Google sign-in page
│   │   ├── api/
│   │   │   └── auth/
│   │   │       ├── google/route.ts     # Initiate Google OAuth
│   │   │       ├── callback/route.ts   # Exchange code, verify domain, issue JWT
│   │   │       └── logout/route.ts     # Clear session cookie
│   │   └── docs/
│   │       └── [...slug]/page.tsx      # Catch-all MDX renderer
│   ├── components/
│   │   ├── Sidebar.tsx
│   │   ├── DocRenderer.tsx
│   │   ├── SignInPage.tsx
│   │   ├── Header.tsx
│   │   └── mdx/
│   │       ├── Callout.tsx
│   │       ├── FeatureMatrix.tsx
│   │       └── Milestone.tsx
│   ├── lib/
│   │   ├── auth.ts                 # OAuth helpers, JWT sign/verify
│   │   ├── content.ts              # MDX loading, frontmatter parsing
│   │   └── config.ts               # Load docs.config.json
│   └── middleware.ts               # Auth gate
├── content/                        # MDX docs by section
│   ├── getting-started/
│   │   ├── index.mdx
│   │   └── why-new-platform.mdx
│   ├── architecture/
│   │   ├── index.mdx
│   │   └── system-overview.mdx
│   ├── migration/
│   │   ├── index.mdx
│   │   └── strategy.mdx
│   ├── product/
│   │   ├── index.mdx
│   │   ├── feature-parity.mdx
│   │   └── milestones.mdx
│   ├── enterprise/
│   │   ├── index.mdx
│   │   └── readiness.mdx
│   ├── api-reference/
│   │   └── index.mdx
│   ├── runtime/
│   │   └── index.mdx
│   ├── studio/
│   │   └── index.mdx
│   └── search-ai/
│       └── index.mdx
├── docs.config.json
├── package.json
├── next.config.mjs
├── tsconfig.json
└── tailwind.config.js
```

### Auth Flow

1. User hits any docs page (e.g., `/docs/migration/strategy`)
2. `middleware.ts` checks for `docs-session` httpOnly cookie with valid JWT
3. If missing/invalid/expired: redirect to `/auth/signin?redirect=/docs/migration/strategy`
4. Sign-in page shows branding + "Sign in with Google" button
5. Click triggers `GET /api/auth/google`:
   - Reads `redirect` from query param or referrer
   - Generates 32-byte cryptographically random CSRF state via `crypto.randomBytes(32).toString('hex')`
   - Stores state + redirect URL in `oauth_state` cookie: `httpOnly`, `secure` (in production), `sameSite=lax`, `maxAge=600` (10 min), `path=/api/auth`
   - Redirects to Google OAuth consent screen
6. Google redirects to `GET /api/auth/callback?code=...&state=...`
7. Callback:
   - Validates CSRF: compares `state` query param against `oauth_state` cookie value (constant-time comparison)
   - Immediately deletes `oauth_state` cookie (prevents replay)
   - Exchanges code for tokens via `google-auth-library`
8. Extracts email from ID token, checks domain against `docs.config.json` `allowedDomains`
9. If domain not allowed: renders "Access Denied" page (no redirect to Studio)
10. If allowed: creates signed JWT (`jose` library), sets `docs-session` httpOnly cookie (24h)
11. Recovers original redirect URL from the `oauth_state` cookie (stored alongside CSRF state in step 5)
12. **Redirect validation**: verifies redirect is a relative path (starts with `/`, no `//`, no protocol scheme). If invalid, defaults to `/`
13. Redirects to validated URL

**Middleware matcher:** All paths except `/auth/*`, `/api/auth/*`, `/_next/*`, `/favicon.ico`

**JWT payload:** `{ email, name, picture, domain, iat, exp }`

**JWT session notes:**

- 24-hour expiry, no refresh token — user signs in again next day
- No database-backed session revocation. Trade-off: simplicity over instant revocation
- Emergency revocation: rotate `DOCS_JWT_SECRET` to invalidate all active sessions
- `DOCS_JWT_SECRET` is required at startup — app fails fast if missing

**Env vars:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (shared with Studio), `DOCS_JWT_SECRET` (independent)

**Google Cloud Console:** Add `http://localhost:3004/api/auth/callback` as an authorized redirect URI to the existing OAuth client.

### Error Handling

| Scenario                             | Behavior                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `DOCS_JWT_SECRET` missing at startup | App fails fast with clear error message                                  |
| `GOOGLE_CLIENT_ID`/`SECRET` missing  | Sign-in page shows "Google OAuth not configured"                         |
| Google OAuth network failure         | Redirect to `/auth/signin?error=oauth_failed` with user-friendly message |
| Invalid CSRF state                   | Redirect to `/auth/signin?error=invalid_state`                           |
| Domain not allowed                   | Inline "Access Denied" on sign-in page (no redirect)                     |
| Malformed MDX file                   | Render error boundary with "This page has a formatting issue"            |
| Expired JWT                          | Middleware redirects to sign-in (normal flow)                            |

### Config File

`docs.config.json` (checked into repo):

```json
{
  "allowedDomains": ["kore.ai"],
  "siteName": "Agent Platform v2 — Internal Docs",
  "sections": [
    { "slug": "getting-started", "title": "Getting Started" },
    { "slug": "architecture", "title": "Architecture" },
    { "slug": "migration", "title": "Migration Strategy" },
    { "slug": "product", "title": "Product Readiness" },
    { "slug": "enterprise", "title": "Enterprise Readiness" },
    { "slug": "api-reference", "title": "API Reference" },
    { "slug": "runtime", "title": "Runtime" },
    { "slug": "studio", "title": "Studio" },
    { "slug": "search-ai", "title": "SearchAI" }
  ]
}
```

### Content Format

MDX files with frontmatter:

```mdx
---
title: 'Why a New Platform'
section: 'getting-started'
order: 1
description: 'The case for rebuilding from the ground up'
---

Content here. Supports standard markdown plus custom components:

<Callout type="info">Key insight about the platform</Callout>

<FeatureMatrix
  features={[
    { name: 'Multi-agent', legacy: false, v2: true },
    { name: 'LLM-native', legacy: false, v2: true },
  ]}
/>

<Milestone status="done" date="2026-Q1">
  Core runtime GA
</Milestone>
```

### Content Sections

| Section              | Audience      | Content                                               |
| -------------------- | ------------- | ----------------------------------------------------- |
| Getting Started      | All           | Why new platform, what's different, quick orientation |
| Architecture         | Technical     | System overview, component map, data flow             |
| Migration Strategy   | All           | Timeline, phases, coexistence plan, rollback strategy |
| Product Readiness    | Non-technical | Feature parity matrix, milestones, release timeline   |
| Enterprise Readiness | All           | Multi-tenancy, security, compliance, scale            |
| API Reference        | Technical     | REST/WS APIs, SDK usage                               |
| Runtime              | Technical     | Execution engine, agent lifecycle, guardrails         |
| Studio               | Technical     | IDE features, DSL editor, topology                    |
| SearchAI             | Technical     | Ingestion, connectors, pipelines                      |

### UI Layout

**Sign-in page:**

- Centered card, clean background
- App logo, title "Agent Platform v2 — Internal Docs"
- Subtitle: "Sign in with your organization account"
- Single "Sign in with Google" button
- Domain rejection shows inline error, no redirect elsewhere

**Docs layout (authenticated):**

- Header: site name (left), user avatar + name + logout (right)
- Sidebar (left, collapsible): section navigation from config, expandable with page links
- Content area: rendered MDX with Tailwind Typography prose styles
- Table of contents (right, wider screens): auto-generated from headings
- Mobile: sidebar collapses to hamburger

**Visual style:**

- Light mode, documentation-focused (not Studio's dark theme)
- `@agent-platform/tailwind-config` for base consistency
- `@tailwindcss/typography` for prose rendering

### Dependencies

| Package                           | Purpose                                        |
| --------------------------------- | ---------------------------------------------- |
| `next` (16.x)                     | Framework                                      |
| `react`, `react-dom` (19.x)       | UI                                             |
| `google-auth-library`             | Google OAuth                                   |
| `jose`                            | JWT sign/verify (lightweight, Edge-compatible) |
| `next-mdx-remote`                 | MDX rendering                                  |
| `gray-matter`                     | Frontmatter parsing                            |
| `@agent-platform/tailwind-config` | Shared Tailwind (devDependency)                |
| `@tailwindcss/typography`         | Prose styles (devDependency)                   |
| `lucide-react`                    | Icons                                          |
| `clsx`                            | Class composition                              |

No dependency on `@agent-platform/database`, `@agent-platform/shared-auth`, or any runtime packages.

### Monorepo Integration

- Package name: `@agent-platform/docs-internal`
- Port: 3004 (confirmed free — not used by any existing service in `constants.ts`)
- Port constant `DEFAULT_DOCS_INTERNAL_PORT = 3004` added to `packages/config/src/constants.ts`
- Port added to `DEFAULT_LOCAL_PORTS` and `DEFAULT_LOCAL_ORIGINS` for CORS consistency
- Included in `pnpm dev:all` turbo pipeline
- Own `.env.example` with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DOCS_JWT_SECRET`
- Pin `next-mdx-remote` to v5.x in `package.json` (v5 has breaking changes from v4)
- `turbo.json` override: `"@agent-platform/docs-internal#build": { "outputs": [".next/**"] }` (Next.js outputs to `.next/`, not `dist/`)

**Note:** When a Dockerfile is eventually added, follow monorepo conventions: copy `pnpm-lock.yaml` and all workspace `package.json` files needed for dependency resolution.

## Not Included (Intentional)

- No full-text search (add later with client-side index)
- No versioning (single living version)
- No CMS or admin panel
- No Dockerfile (add when deploy target is decided)
- No analytics/tracking
- No dark mode toggle (add later if requested)
- No unit tests in initial scaffold (add for auth middleware/domain whitelist logic during implementation)
