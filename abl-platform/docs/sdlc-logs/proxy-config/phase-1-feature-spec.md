# SDLC Log: proxy-config -- Phase 1 (Feature Spec)

**Date**: 2026-03-23
**Artifact**: `docs/features/proxy-config.md`

## Summary

Generated feature spec for the Proxy Configuration feature. The feature is substantially implemented -- database model, repository functions, CRUD routes, ProxyResolver, ProxyConfigService, RBAC roles, and unit tests all exist. The spec documents the current state, not a greenfield design.

## Key Findings from Codebase Analysis

1. **Auth type enum mismatch**: Route Zod schemas use `['none', 'basic', 'bearer', 'custom']` but ProxyResolver uses `['none', 'basic', 'bearer', 'api_key']`. The `custom` type stored in DB is never handled by ProxyResolver.
2. **No Studio UI**: No proxy config components exist in `apps/studio/src/`.
3. **No E2E tests**: All 20 authz tests mock repos and middleware. The RBAC enforcement is tested against real `requirePermission` but DB operations are mocked.
4. **LLM calls not proxied**: ProxyResolver is wired into HttpToolExecutor but not into the LLM provider factory (`packages/llm/src/provider-factory.ts`).
5. **Cache unbounded**: ProxyConfigService uses a plain `Map` with no max size or eviction.
6. **Update route missing validation**: PUT handler validates caCertificate length but not clientCert/clientKey length.

## Decisions

- D1: Org-level only (no per-project proxy) -- enterprise proxies are org-wide
- D2: Hard delete (not soft delete) -- infra configs, not user data
- D3: Glob-based hostname matching -- safer than full URL regex
- D4: proxyUrl masked in list responses -- defense in depth
