# SDLC Log: proxy-config -- Phase 4 (LLD)

**Date**: 2026-03-23
**Artifact**: `docs/plans/2026-03-23-proxy-config-impl-plan.md`

## Summary

Generated LLD and 5-phase implementation plan. Since the feature is substantially implemented, the plan focuses on bug fixes, gap closure, and enhancements rather than greenfield construction.

## Phase Breakdown

1. **Phase 1 (P0)**: Fix auth type enum mismatch, add missing validation, add cache size limit -- 3 tasks, S effort
2. **Phase 2 (P1)**: Add GET /:id endpoint, write E2E tests, encryption integration tests -- 3 tasks, M effort
3. **Phase 3 (P1)**: Route LLM provider calls through org proxy -- 1 task, L effort
4. **Phase 4 (P1)**: Studio UI for proxy config management -- 3 tasks, L effort
5. **Phase 5 (P2)**: Cross-pod cache invalidation, error envelope normalization, auth profile testing -- 3 tasks, M effort

## Critical Bug Found

**Auth type enum mismatch** (GAP-10): The Zod schemas accept `custom` but ProxyResolver expects `api_key`. If an admin creates a proxy config with `custom` auth type, the ProxyResolver falls through to `default: break` and silently drops the auth header. This means the proxy request goes through unauthenticated, which could cause 407 Proxy Authentication Required errors at runtime.

## Wiring Verification

All 9 integration points verified as DONE -- route registered, repos exported, model indexed, types exported, ProxyConfigService wired into LLMWiring, system roles include proxy permissions.
