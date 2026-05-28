# Auth Profile Hardening Plan

> **For agentic workers:** Use superpowers:executing-plans to implement.

**Goal:** Fix 3 critical, 9 important, and 7 suggested issues across Studio, API, resolution chain, and entity mappings.

---

## Phase 1: Critical Fixes (Security + Data Integrity)

### Task 1: SSRF in validate endpoint

- File: `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/validate/route.ts`
- Add `validateUrlForSSRF()` on `config.tokenUrl` before `fetch()` at line 71

### Task 2: SSRF in OAuth callback token exchange

- File: `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts`
- Re-validate `tokenUrl` from app profile before fetch at line 93

### Task 3: Cascade delete protection

- Files: `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/route.ts`, `packages/shared/src/services/auth-profile.service.ts`
- Before deleting, query ALL 16 entity models for `authProfileId` references
- Return 409 with referencing entity types and counts if any exist

### Task 4: Redis soft-fail in user-consent

- File: `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/user-consent/route.ts`
- Return 503 when Redis is unavailable instead of silently proceeding

---

## Phase 2: Important Fixes (Correctness + Consistency)

### Task 5: Fix encryption/lean asymmetry in GET handlers

- Files: auth-profiles list and detail GET routes
- Verify Mongoose encryption plugin with `.lean()`, fix if reads return ciphertext

### Task 6: Compute linkedConsumerCount in list API

- Fix hardcoded `0` in list response
- Expand `/consumers` endpoint to query all 16 entity models

### Task 7: Fix PUT/DELETE asymmetry on project routes

- Align scope: either allow editing inherited tenant profiles or return clear 403

### Task 8: Standardize error handling across 10 wired consumers

- When authProfileId IS set + enabled: null return = throw (not silent fallback)
- Update: connection-resolver, pipeline-factory, git-credentials, arch-llm

### Task 9: Remove unnecessary type cast in ServiceNode consumer

- Replace `(serviceNode as any).authProfileId` with `serviceNode.authProfileId`

### Task 10: Fix console.error in MCP server registry

- Replace with `createLogger('mcp-server-registry')`

### Task 11: Document dead authProfileId on 8 unwired entity models

- Add JSDoc noting field is reserved for future auth profile migration

### Task 12: Add lastUsedAt update to model-resolution inline resolver

- Same fire-and-forget debounced pattern as runtime and search-ai resolvers

---

## Phase 3: Suggestions (Robustness)

### Task 13: Replace sort-based priority with explicit numeric ordering

- In 5-level resolve, use computed priority instead of string sort

### Task 14: Add soft-delete (status: archived) with grace period

- Archived profiles stop resolving (status filter) but records preserved

### Task 15: Type the auth-profile.service model dependency

- Replace `model: any` with `Model<IAuthProfile>`

---

## Execution: 3-Pass Review Cycle

```
Pass 1: Implement Phase 1 (4 tasks) -> 3 auditors review -> fix issues
Pass 2: Implement Phase 2 (8 tasks) -> 3 auditors review -> fix issues
Pass 3: Implement Phase 3 (3 tasks) -> 3 auditors review -> final
```
