# LLD Log: Studio Theme & Docs Integration

**Phase**: LLD
**Date**: 2026-03-25
**Artifact**: `docs/plans/2026-03-25-studio-theme-docs-integration-impl-plan.md`
**Feature Spec**: `docs/features/ancillary/studio-theme-docs-integration.md`
**Test Spec**: `docs/testing/ancillary/studio-theme-docs-integration.md`
**HLD**: Skipped (user decision — feature is small, no new services/data models)

---

## Oracle Decisions

All 14 clarifying questions answered by product-oracle. No AMBIGUOUS items escalated to user.

### Implementation Strategy (5 questions)

| #   | Question                                     | Classification | Answer Summary                                                                                              |
| --- | -------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | Implementation order (theme vs docs)         | DECIDED        | Theme first, then docs. Commit discipline, risk isolation.                                                  |
| 2   | Existing route-level access control patterns | ANSWERED       | No email-domain gating exists. API auth via `requireAuth()`. Client-side conditional rendering in UserMenu. |
| 3   | Feature flag vs always-on                    | ANSWERED       | Always-on with 404. Feature spec explicit: "No feature flags."                                              |
| 4   | Phase scope                                  | DECIDED        | 6 phases: theme, access lib, content+MDX, routing, tests, verification.                                     |
| 5   | Test-first vs test-after                     | DECIDED        | Test-after per phase. Test-first creates compilation errors against non-existent code.                      |

### Technical Details (5 questions)

| #   | Question                     | Classification | Answer Summary                                                                            |
| --- | ---------------------------- | -------------- | ----------------------------------------------------------------------------------------- |
| 6   | Files to modify vs create    | ANSWERED       | 4 modified (AppShell, UserMenu, next.config, package.json), 13+ created.                  |
| 7   | Content directory structure  | ANSWERED       | `apps/studio/content/` at app root (not src/). Mirrors docs-internal.                     |
| 8   | MDX dependencies to add      | ANSWERED       | `gray-matter`, `next-mdx-remote`, `remark-gfm`, `mermaid`, `@tailwindcss/typography`.     |
| 9   | Access gate architecture     | DECIDED        | Hybrid: server component layout check + client domain check. Layout-level in route group. |
| 10  | Standalone build for content | ANSWERED       | Add `'/docs': ['./content/**/*', './docs.config.json']` to `outputFileTracingIncludes`.   |

### Risk & Dependencies (4 questions)

| #   | Question                    | Classification | Answer Summary                                                                                |
| --- | --------------------------- | -------------- | --------------------------------------------------------------------------------------------- |
| 11  | Conflicting changes         | ANSWERED       | No active conflicts. Last changes to target files were stable refactors.                      |
| 12  | Biggest implementation risk | INFERRED       | Existing `/docs/abl` and `/docs/agent-anatomy` route collision. Use `(internal)` route group. |
| 13  | Preserve toggle()           | ANSWERED       | Yes — additive commit rule. Leave ThemeToggle.tsx file in place.                              |
| 14  | Fix Mermaid .catch()        | DECIDED        | Yes, include in migration. Natural time, one-line fix, mandated by no-swallowed-catches rule. |

---

## Critical Discovery: Route Collision

Existing routes at `apps/studio/src/app/docs/abl/page.tsx` and `apps/studio/src/app/docs/agent-anatomy/page.tsx` (client components for ABL Language and Agent Anatomy docs). Feature spec did not account for these.

**Resolution**: Use Next.js route group `(internal)` for MDX docs:

- `docs/(internal)/layout.tsx` — access gate (only wraps MDX routes)
- `docs/(internal)/[...slug]/page.tsx` — MDX renderer
- Existing `docs/abl/` and `docs/agent-anatomy/` remain unaffected (static routes take precedence)

---

## Audit Results

### Round 1: NEEDS_CHANGES (lld-reviewer)

**CRITICAL (1):**

- Auth fundamentally broken: refresh_token is opaque hex (not JWT), cannot be decoded in server layout → Created internal API route `/api/docs/access` (D-9)

**HIGH (7):**

- `DOCS_ALLOWED_DOMAINS` invisible to client components → Renamed to `NEXT_PUBLIC_DOCS_ALLOWED_DOMAINS` (D-10)
- MenuItem lacks right-side icon support → Extended with `end` prop (D-11)
- ThemeToggle line reference 306 → Corrected to 308
- i18n keys missing → Added `theme_system`, `theme_light`, `theme_dark`, `docs`
- `bg-background-inverse`/`text-foreground-inverse` don't exist → Use `.docs-code-block` class (D-12)
- `bg-border-default` not a background utility → Use `bg-background-muted`
- MDX count discrepancy → Verified 74 is correct

### Round 2: NEEDS_CHANGES (lld-reviewer)

**CRITICAL (1):**

- Auth token resolution chain not specified → Added full chain: `hashToken()` → `findRefreshToken()` (READ-ONLY, NOT `refreshTokens()`) → verify → `findUserById()`

**HIGH (3):**

- MenuItem `end` render location unspecified → Added: render after shortcut span at ~line 308
- Docs link uses `router.push()` but no `useRouter` import → Changed to `window.location.href`
- text-subtle/text-muted mapping backwards → Swapped: `text-slate-500` → `text-subtle`, `text-slate-600` → `text-muted`

### Round 3: NEEDS_CHANGES (lld-reviewer, completeness focus)

**CRITICAL (1):**

- `@tailwindcss/typography` not registered in Tailwind config plugins array → Added task 4.8

**HIGH (3):**

- API response must use platform envelope `{ success, data }` → Fixed
- `__dirname` not available in ESM → Removed fallback, use only `process.cwd()`
- `gray-matter` needs to be in `serverExternalPackages` → Added to task 4.9

**MEDIUM (5):**

- Check icon missing `shrink-0` → Fixed
- Callout border opacity too bold → Added `/30` modifier note
- `outputFileTracingIncludes` key pattern verification → Added note
- `docs.config.json` path resolution note → Added to content.ts
- `remaining-stores.test.ts` naming → Already correct in LLD

### Round 4: NEEDS_REVISION (phase-auditor, cross-phase consistency)

**CRITICAL (2, deferred to post-impl-sync):**

- Env var name inconsistent: feature spec says `DOCS_ALLOWED_DOMAINS`, LLD uses `NEXT_PUBLIC_DOCS_ALLOWED_DOMAINS`
- Test file name inconsistent: test spec says `theme-store.test.ts`, actual is `remaining-stores.test.ts`

**HIGH (5):**

- New API route `/api/docs/access` not in feature spec → Added to §8 discrepancies
- S-4 coverage needed → Covered by UT-2 in Phase 2
- No FR-to-phase traceability table → Added
- text-muted/subtle clarification needed → Already fixed in round 2
- Security scenario mapping → Added S-1 through S-10 mapping to Phase 5

### Round 5: APPROVED (lld-reviewer, final sweep)

**MEDIUM (2, fixed inline):**

- Tailwind typography plugin uses CommonJS `require()` in ESM config → Fixed to ESM import in `apps/studio/tailwind.config.js`
- FR-to-phase traceability table used incorrect FR numbering → Re-aligned to match feature spec §4

**Verified:**

- Task independence: all 6 phases are sequential with no destructive file overlap
- Wiring checklist: 18 items, all correctly reference phases and tasks
- Platform principles: isolation (404 for non-allowed), auth (read-only token lookup), stateless, traceability
- All 74 MDX files and 16 sections verified against source
- All function signatures verified against codebase (findRefreshToken, hashToken, useThemeStore.setMode, etc.)
- Route group `(internal)` correctly isolates access gate from existing `/docs/abl` and `/docs/agent-anatomy`

---

## Files Created/Modified

- Created: `docs/plans/2026-03-25-studio-theme-docs-integration-impl-plan.md`
- Modified: `docs/sdlc-logs/studio-theme-docs-integration/lld.log.md` (this file)

## Next Phase

Run `/implement studio-theme-docs-integration`
