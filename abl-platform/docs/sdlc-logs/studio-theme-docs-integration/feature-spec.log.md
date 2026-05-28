# SDLC Log: Studio Theme System & Internal Docs Integration — Feature Spec

**Phase**: Feature Spec
**Date**: 2026-03-25
**Status**: GENERATED

---

## Oracle Session

All 15 clarifying questions answered by product-oracle. No AMBIGUOUS items — no user escalation needed.

### Classifications

| #   | Question                                   | Classification           | Summary                                                                   |
| --- | ------------------------------------------ | ------------------------ | ------------------------------------------------------------------------- |
| Q1  | Theme UI format in UserMenu                | INFERRED                 | Three MenuItem rows with Check icon (matches workspace switcher pattern)  |
| Q2  | Default theme mode                         | ANSWERED (user override) | User explicitly said "system as default" — `mode: 'system'`               |
| Q3  | Who can access docs                        | ANSWERED                 | Only email domains in allowlist (kore.ai, kore.com)                       |
| Q4  | Remove docs-internal auth routes           | INFERRED                 | Yes, Studio's auth replaces them entirely                                 |
| Q5  | Supersedes standalone design               | DECIDED                  | Yes, consolidation eliminates separate deployment                         |
| Q6  | Primary personas for docs                  | ANSWERED                 | Internal team members only (kore.ai/kore.com)                             |
| Q7  | Theme sync across tabs                     | ANSWERED                 | Already works via localStorage — no additional work needed                |
| Q8  | Docs in sidebar vs UserMenu                | DECIDED                  | UserMenu link (conditional on domain), not sidebar                        |
| Q9  | Content authoring from Studio              | DECIDED                  | Read-only; content authored in repo via git                               |
| Q10 | RBAC for docs                              | DECIDED                  | Email-domain only; RBAC adds no value for static content                  |
| Q11 | Mermaid lazy loading                       | ANSWERED                 | Already lazy per-diagram via dynamic import                               |
| Q12 | Content format (filesystem vs pre-compile) | DECIDED                  | Filesystem + outputFileTracingIncludes (matches existing pattern)         |
| Q13 | Allowlist config method                    | DECIDED                  | Env var (DOCS_ALLOWED_DOMAINS) with hardcoded fallback                    |
| Q14 | Response for non-allowed users             | ANSWERED                 | 404 per CLAUDE.md Core Invariant #1                                       |
| Q15 | Docs styling approach                      | INFERRED                 | Use Studio's semantic tokens entirely; docs-internal tokens are identical |

### User Overrides

- Q2: Oracle inferred `'system'` based on codebase defaults. User initially said "light as default", then corrected to "system as default". Final: `mode: 'system'`.

---

## Files Created

- `docs/features/studio-theme-docs-integration.md` — Feature spec
- `docs/testing/studio-theme-docs-integration.md` — Testing guide placeholder
- `docs/sdlc-logs/studio-theme-docs-integration/feature-spec.log.md` — This file

---

## Open Questions Logged

1. Should `apps/docs-internal/` be removed in same PR or follow-up?
2. Should docs content be cached in memory after first read?
3. Should docs sidebar collapse on mobile?

---

## Packages Touched

- `apps/studio` — Primary target for all changes
- `apps/docs-internal` — Source for content and component migration (not modified)
