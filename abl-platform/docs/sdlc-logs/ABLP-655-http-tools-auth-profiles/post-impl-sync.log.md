# Post-Implementation Sync: ABLP-655 — HTTP Tools Auth Profiles Not Resolving

**Date**: 2026-05-20
**Branch**: `fix/ABLP-655-http-tools-auth-profiles-not-resolving`
**Commit**: `25330b663b`
**Ticket**: https://koreteam.atlassian.net/browse/ABLP-655

---

## What Was Fixed

Four distinct bugs, all in the auth profile resolution pipeline:

### Bug 1 (Critical): `auth_profile_ref` dropped from resolved tool definition

**File**: `packages/shared/src/tools/resolve-tool-implementations.ts`
**Root Cause**: `toToolDefinition()` built `ToolDefinitionLocal` for the compiler's `resolvedToolImplementations` option but never propagated `auth_profile_ref`, `jit_auth`, `connection_mode`, `consent_mode` from `props`. The compiler received tool definitions without `auth_profile_ref`, so agent IR tools had no auth profile reference. The runtime auth-profile middleware checks `tool.auth_profile_ref` before running — with it absent, the middleware skipped every tool, and inline auth (which had no credentials) was attempted instead.
**Fix**: Added 4 spread lines in `toToolDefinition()` to propagate all four fields from `props`.

### Bug 2 (Medium): `api_key` prefix applied without space

**File**: `packages/shared-auth-profile/src/apply-auth.ts`
**Root Cause**: `applyAuth()` for `api_key` concatenated `prefix + apiKey` directly. With prefix `"Basic"`, result was `"Basicabc123"` instead of `"Basic abc123"`. The `bearer` case already had this fixed. `withPrefix()` helper extracted and shared across both branches.
**Fix**: Added `withPrefix(prefix, value)` helper; both `api_key` and `bearer` use it.

### Bug 3 (Medium): Inline literal secrets persisted with auth profile ref

**File**: `packages/shared-kernel/src/utils/http-auth-config-normalizer.ts`
**Root Cause**: `normalizeHttpAuthConfig()` preserved `apiKey` and `token` in the normalized output even when `hasAuthProfileRef` was true. Literal credentials were written to the tool DSL alongside the auth profile reference, causing false-positive `LITERAL_AUTH_VALUE` publish-safety violations and polluting the DSL with unused secrets.
**Fix**: Guard `apiKey` and `token` copy behind `!hasAuthProfileRef`.

### Bug 4 (Low): False-positive `LITERAL_AUTH_VALUE` on auth type keywords

**File**: `packages/project-io/src/module-release/module-publish-safety.ts`
**Root Cause**: `AUTH_CONFIG_RE` matched `auth: api_key` DSL lines. The validator captured `api_key` as the auth value, found no template or `auth_profile_ref` in it, and raised `LITERAL_AUTH_VALUE`. Auth type names like `api_key`, `bearer`, `oauth2_client` are not secrets.
**Fix**: Added `AUTH_TYPE_KEYWORDS` Set; captured values matching known type names are skipped.

---

## Coverage Delta

| Type                       | Before | After         |
| -------------------------- | ------ | ------------- |
| Bug fixes                  | 0      | 4             |
| Unit tests for these paths | 0      | 0 (follow-up) |
| Build status               | ✅     | ✅            |

---

## Deviations from Plan

- Initial RCA incorrectly identified the UI (OAuth fields shown for API key profiles) as the primary issue. That was a secondary UI bug addressed in ABLP-913; ABLP-655's root cause was the `resolveToolImplementations` drop.
- Attempted incorrect fix of adding `auth_profile`/`auth` fields to agent DSL TOOLS section (reverted) — compiler correctly rejects implementation properties in the agent TOOLS section.
- Turbopack enabled for Studio dev mode as part of this branch (`apps/studio/package.json`).

---

## Remaining Gaps

- Unit tests for all four fix paths are not yet written — tracked as follow-up.
- Agent auth profile fields (connection/consent/jit) in the agent TOOLS section would be useful for per-agent overrides but are currently blocked by compiler validation. Design decision needed.
