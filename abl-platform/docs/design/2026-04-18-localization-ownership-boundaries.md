# Localization Ownership Boundaries

**Date**: 2026-04-18
**Status**: Accepted
**Owner**: Prasanna (platform), to be co-owned by agent-platform and studio leads

## Decision

Project localization and platform localization are **separate ownership
domains** with separate catalogs and separate release cadences. Runtime
resolution dispatches by ownership domain — there is **no single shared
source of truth** for translated copy.

Two catalogs:

| Catalog              | Location                                                              | Owner               | Scope                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project catalog**  | `locales/<locale>/<asset>.json` inside a project bundle               | Agent developers    | Project-owned agent/scripted content: prompts the agent speaks, scripted flow messages, project-specific error surfaces, onboarding copy embedded in the agent experience. |
| **Platform catalog** | Shared platform i18n / runtime system catalogs (see _Implementation_) | Platform developers | Platform-owned UI/system copy: Studio chrome, auth screens, runtime error banners, deterministic system messages, admin surfaces, billing strings.                         |

The catalogs do not overlap. A string belongs to exactly one domain.

## Why

Earlier attempts to merge both domains into one catalog collided on three
axes:

1. **Release cadence mismatch.** Platform strings ship with the platform
   release; project strings ship with the project bundle. A shared catalog
   forced one team to wait for the other whenever a string changed.
2. **Permission mismatch.** Agent developers should not be able to rewrite
   auth-screen copy or billing errors; platform developers should not be
   editing a specific project's onboarding flow.
3. **Runtime resolution ambiguity.** With one source of truth, two
   different strings could legitimately claim the same key (`errors.network`
   as the agent's scripted reply _and_ the runtime's connection banner).
   Separating domains removes the collision by construction.

## Personas & Swim Lanes

```
┌─────────────────┬───────────────────────┬───────────────────────┐
│                 │ Platform catalog      │ Project catalog       │
├─────────────────┼───────────────────────┼───────────────────────┤
│ Authors         │ Platform developers   │ Agent developers      │
│ Ships with      │ Platform release      │ Project bundle        │
│ Reviewed by     │ Platform i18n owner   │ Project/tenant owner  │
│ Translated by   │ Central translation   │ Tenant translation    │
│                 │ vendor (platform)     │ process (tenant-chosen)│
│ Versioned by    │ Platform semver       │ Project version       │
│ Cached under    │ Runtime process scope │ Session/project scope │
└─────────────────┴───────────────────────┴───────────────────────┘
```

### End user

- Picks a locale preference (browser header, profile setting, or per-session
  override).
- Reads copy rendered in that locale; does **not** distinguish between
  platform and project sources — the boundary is invisible at the UI.
- Sees a consistent locale across both domains when both have coverage for
  the requested locale; falls back to the platform default locale
  (`en-US`) for the missing domain if one catalog lags behind.
- **Never** sees a translation key (`errors.network`) as a fallback —
  missing translations resolve to the platform default locale, not to the
  key.

### Agent developer

- Owns all strings their project speaks or scripts.
- Adds / edits entries in `locales/<locale>/<asset>.json` inside the project
  bundle. Each asset (agent, flow, tool, onboarding) gets its own file so
  multiple developers can work in parallel without merge conflicts.
- Does **not** touch platform catalogs. If a platform string is wrong or
  missing for their use case, files a platform ticket — does not ship a
  workaround inside the project catalog.
- Bundles translations with the project version: publishing project
  `v1.4.0` publishes the locale files pinned to that version. Rolling back
  the project rolls back its translations atomically.
- Reviews by tenant/project owner before publish; translation vendor is
  whoever the tenant chooses (may be the platform vendor, may be
  in-house, may be a third party).

### Platform developer

- Owns platform catalogs: Studio, Admin, runtime error surfaces, auth,
  billing, shared chrome.
- Adds / edits platform strings via the platform repo; ships them with the
  platform release cycle.
- Does **not** inject project-specific copy into platform catalogs. A
  project needing a custom error message renders it from its own
  project-catalog key.
- Coordinates with central translation vendor; locale coverage matrix is a
  platform SLA and published.

## Runtime Resolution

The runtime resolves a translation request in this order:

1. **Classify the domain** from the call site. Keys are prefixed or routed
   by ownership domain — e.g., `platform:errors.network` vs
   `project:<projectId>.onboarding.welcome`. There is no bare-key lookup
   that searches both catalogs.
2. **Load the catalog for that domain**:
   - Platform: process-scoped cache populated at runtime boot from
     platform-shipped JSON.
   - Project: session/project-scoped cache populated on project activation
     from the project bundle.
3. **Resolve the key** against the loaded catalog for the requested locale.
4. **Fallback** — missing key in requested locale → same catalog's
   default locale (`en-US`). Missing in default locale → log a drift
   event (see _Drift Detection_); render a stable stringified identifier
   so end users never see a raw `t('foo.bar')` token but triage is still
   possible.

The runtime **never** cross-falls between domains. A missing platform
string does not fall through to a project catalog, and vice versa.

## What Goes Where

| Copy type                                                 | Catalog  |
| --------------------------------------------------------- | -------- |
| Agent's scripted reply ("Please share your order number") | Project  |
| Project-specific tool error surfaced in chat              | Project  |
| Project onboarding / welcome copy                         | Project  |
| Runtime connection-lost banner                            | Platform |
| Auth screen labels and buttons                            | Platform |
| Admin UI chrome                                           | Platform |
| Billing invoices / dunning                                | Platform |
| "Your session has expired" banner                         | Platform |
| Model configuration error (user-facing sanitized)         | Platform |
| Studio editor labels and tooltips                         | Platform |

Rule of thumb: _if this string changes because of a change to **this
project**, it belongs in the project catalog; if it changes because of a
change to **the platform**, it belongs in the platform catalog._

## Anti-Patterns

1. **Platform copy embedded in a project catalog.** A project overriding
   "Invalid email" or "Session expired" fragments the user experience
   across tenants and leaks the platform's API surface into projects. If
   a platform string is wrong, fix the platform catalog — don't patch it
   in project bundles.
2. **Project copy in the platform catalog.** A one-off onboarding string
   hardcoded into Studio ties a tenant's wording to a platform release.
3. **Cross-domain fallback.** Having the runtime fall through from
   platform → project (or vice versa) when a key is missing reintroduces
   the ambiguity the split was designed to remove. Missing key is a bug;
   it gets logged and fallbacks to the default locale of the _same_
   catalog.
4. **Single shared JSON file.** There is no `en-US.json` that both
   teams merge into. Merge conflicts on that file were the symptom that
   drove this separation.
5. **Tenant editing platform catalogs via a Studio UI.** Platform copy is
   source-controlled by platform; there is no runtime override path for a
   tenant to reach into it. (Tenant-scoped customization of chrome copy,
   if and when we build it, is a separate _customization_ feature with
   its own catalog layer above the platform catalog — out of scope for
   this decision.)

## Drift Detection

Unowned / misowned strings are a concrete drift signature. The Helix
concerns registry gets two new detectors (advisory tier):

1. **Unowned user-facing string** — a TSX literal rendered to the user
   that is not wrapped in either `t(platform:…)` or `t(project:…)`.
2. **Cross-domain key** — a platform file reaching for a `project:`
   key, or a project file reaching for a `platform:` key.

These are rolled into `.helix/concerns/advisory/localization.yaml`.
Detector coverage lands in a follow-up change once the runtime keying
convention is finalized.

## Implementation (out of scope for this decision record)

- Concrete locale-file layout for project bundles (`locales/<locale>/<asset>.json`) —
  to be specified in the project-bundle manifest spec.
- Runtime resolver API (`t(domain:key)` vs. a `useTranslations(domain)`
  hook) — to be specified in the platform i18n package.
- Translation vendor wiring and locale-coverage SLA — separate
  operational spec owned by the platform team.
- Drift detectors described above — follow-up change to the
  `.helix/concerns` registry.

## References

- `.helix/concerns/advisory/localization.yaml` — advisory detectors for
  user-facing strings.
- `CLAUDE.md` → _User-Facing Runtime Error Sanitization_ — raw context
  belongs in logs; localized message belongs in the user-visible surface.
- `CLAUDE.md` → _Skills Reference_ → `i18n-guide` — when adding
  user-facing strings.
