# agents.md — packages / shared-auth-profile

Agent learning journal for this package. Append-only log of architectural decisions, patterns, gotchas, and insights discovered during SDLC work.

Agents MUST read this file before modifying code in this package. Agents MUST append learnings after completing work.

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work in this package>
-->

## 2026-05-06 — Auth Profiles protocol/error hardening baseline

**Category**: architecture
**Learning**: Shared auth-profile utilities are now the canonical place for protocol-safe error envelopes and endpoint safety checks. OAuth token/refresh/client-credentials flows should validate token URLs and sanitize emitted errors before surfacing to runtime/studio layers.
**Files**: `src/sanitize-error.ts`, `src/client-credentials-service.ts`, `src/token-refresh-service.ts`, `src/oauth2-app-resolver.ts`, `src/__tests__/sanitize-error.test.ts`, `src/__tests__/client-credentials-service.test.ts`
**Impact**: New auth types or provider integrations should extend this package first; downstream apps should consume sanitized/shared outputs rather than adding ad-hoc protocol logic.

---

**Category**: bug | gotcha
**Learning**: `applyAuth()` for `api_key` type was concatenating prefix directly onto the value without a space (`"Basictoken"` instead of `"Basic token"`). The `bearer` case had already been fixed with `prefix.endsWith(' ') ? '' : ' '` but `api_key` was missed. When fixing one auth type's prefix handling, always audit all other auth type branches in the same switch for the same pattern. Both cases are now unified via `withPrefix()`.
**Files**: `src/apply-auth.ts`
**Impact**: Any new auth type that supports a configurable prefix string (e.g. a future `digest` or `hmac` scheme) must use `withPrefix()` rather than raw concatenation.
