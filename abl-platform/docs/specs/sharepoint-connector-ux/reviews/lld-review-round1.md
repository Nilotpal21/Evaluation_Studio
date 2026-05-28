# LLD Review Round 1: Architecture Compliance

**Document:** `docs/specs/sharepoint-connector-ux/wave1.lld.md`
**HLD Reference:** `docs/specs/sharepoint-connector-ux/sharepoint-connector-ux.hld.md`
**Reviewer:** lld-reviewer agent
**Date:** 2026-03-24
**Focus:** Architecture compliance (10 rules)

---

## Findings

### Finding F-01: T-02 route typo claim is false — routes are already correct

- **Task:** T-02
- **Severity:** CRITICAL
- **Location:** T-02 Problem section and ST-02.1
- **Issue:** The LLD claims there is a route path typo at `connectors.ts` lines 247 and 260: "`/connectors:connectorId` is missing the `/` before the param." This is **factually incorrect**. The actual code at line 247 reads `router.post('/connectors/:connectorId/sync/pause'` and line 260 reads `router.post('/connectors/:connectorId/sync/resume'` — both correctly include the `/` before `:connectorId`.
- **Evidence:**
  - LLD T-02: "the route paths at lines 247 and 260 have a typo: `/connectors:connectorId` is missing the `/`"
  - Actual code at line 247: `router.post('/connectors/:connectorId/sync/pause', async (req: Request, res: Response) => {`
  - Actual code at line 260: `router.post('/connectors/:connectorId/sync/resume', async (req: Request, res: Response) => {`
- **Recommendation:** Remove ST-02.1 entirely. Remove all references to the route path typo from T-02's Problem description and AC-03. This subtask would be a no-op.

---

### Finding F-02: Missing Zod validation on ALL new route parameters

- **Task:** T-06, T-07
- **Severity:** HIGH
- **Location:** T-06 Route Definitions, T-07 Route Definitions
- **Issue:** The LLD specifies new route handlers for audit log and config version endpoints but does not mention Zod validation for any route parameters (`connectorId`, `indexId`, `versionNumber`) or query parameters (`category`, `page`, `limit`, `startDate`, `endDate`, `format`). Platform rules require every route parameter to be validated with Zod.
- **Evidence:**
  - CLAUDE.md: "Every route parameter validated with Zod `.safeParse()`"
  - CLAUDE.md: "Use `z.string().min(1)` for ID fields"
  - T-06 Route Definitions: No Zod schemas defined
  - T-07 Route Definitions: No Zod schemas defined
- **Recommendation:** Add a Zod validation schema for each new route. At minimum:
  - `connectorIdSchema = z.object({ connectorId: z.string().min(1) })`
  - `auditLogQuerySchema = z.object({ category: z.enum(['auth','config','sync','permission','lifecycle']).optional(), page: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().positive().max(100).optional(), startDate: z.string().datetime().optional(), endDate: z.string().datetime().optional() })`
  - `versionNumberSchema = z.object({ versionNumber: z.coerce.number().int().positive() })`
  - `exportFormatSchema = z.object({ format: z.enum(['json','csv']) })`

---

### Finding F-03: New models require projectId but ConnectorConfig has no projectId

- **Task:** T-06, T-07
- **Severity:** HIGH
- **Location:** T-06 Model Schema (`projectId: required: true`), T-07 Model Schema (same)
- **Issue:** Both `ConnectorAuditEntry` and `ConnectorConfigVersion` define `projectId` as a required field. However, the existing `ConnectorConfig` model does NOT have a `projectId` field (verified: grep returns no matches). The existing connector routes also do not reference `projectId`. The LLD does not specify how the route handlers will obtain `projectId` to pass to the service layer.
- **Evidence:**
  - T-06 schema: `projectId: required: true`
  - `connector-config.model.ts`: No `projectId` field exists
  - `connectors.ts` routes: No `projectId` referenced anywhere
- **Recommendation:** Either (a) derive `projectId` from the knowledge base / search index chain and document this resolution in the service layer, or (b) remove `projectId` from these models if connectors are not project-scoped in the current architecture. If keeping it, add a subtask to resolve projectId from `indexId` to `SearchSource` to `KnowledgeBase` to `projectId`.

---

### Finding F-04: Audit route query does not filter by connectorId in tenant-scoped index

- **Task:** T-06
- **Severity:** MEDIUM
- **Location:** T-06 Model Schema, Indexes section
- **Issue:** The first index is `{ connectorId: 1, timestamp: -1 }` without `tenantId`. While the `tenantIsolationPlugin` ensures tenant scoping at the Mongoose level, the primary query index should lead with `tenantId` for the most common query pattern (get audit log for a connector within a tenant). The index `{ tenantId: 1, connectorId: 1, category: 1, timestamp: -1 }` covers this but is overly broad for the simple case.
- **Evidence:**
  - T-06 index: `ConnectorAuditEntrySchema.index({ connectorId: 1, timestamp: -1 })`
  - Platform rule: "Every query includes tenantId" — the primary index should reflect the primary query pattern
- **Recommendation:** Change the primary index to `{ tenantId: 1, connectorId: 1, timestamp: -1 }` which is the actual primary query pattern (`getAuditLog` filters by both `connectorId` AND `tenantId`). Remove the standalone `{ connectorId: 1, timestamp: -1 }` index.

---

### Finding F-05: Version auto-increment race condition acknowledged but fix is insufficient

- **Task:** T-07
- **Severity:** MEDIUM
- **Location:** T-07 Risk Notes
- **Issue:** The LLD acknowledges that `getLatestVersion() + 1` has a race condition under concurrent writes and proposes "retrying with incremented version (up to 3 retries)." This is not architecturally sound for a distributed system. The retry approach can still fail under contention and adds unnecessary complexity.
- **Evidence:**
  - T-07 Risk Notes: "Under concurrent writes, this could produce a duplicate key error. Handle by retrying with incremented version (up to 3 retries)."
  - Platform invariant: "No pod-local state as truth. Redis/MongoDB for shared state."
- **Recommendation:** Use MongoDB's `findOneAndUpdate` with `$inc` atomically on a counter document, or use `countDocuments({ connectorId }) + 1` inside a retry loop (which the LLD already proposes). Actually, the retry-on-duplicate-key approach IS a valid pattern for MongoDB — it leverages the unique index as a concurrency guard. Recommend documenting this explicitly as the pattern rather than just a risk note: "Use unique index `{ connectorId, version }` as optimistic concurrency control. On duplicate key error, re-read latest version and retry (up to 3 attempts)."

---

### Finding F-06: No i18n strategy for frontend components (T-10, T-11)

- **Task:** T-10, T-11
- **Severity:** HIGH
- **Location:** T-10 (SharePointDetailPanel), T-11 (TypeToConfirmInput)
- **Issue:** The review checklist requires: "LLD specifies i18n namespace for each new component", "All user-visible strings planned as translation keys", "aria-labels included in i18n scope", "New keys specified for `packages/i18n/locales/en/studio.json`." The LLD specifies no i18n strategy for any frontend component. T-10 has hardcoded strings like "Connect", "Proposal", "Scope+Filters", "Preview", "Security", "History", "Overview", "(Draft)", "Tab content - Wave N". T-11 has "Confirm", "Cancel", "Type to confirm" as defaults.
- **Evidence:**
  - T-10 tab configuration: `{ id: 'connect', label: 'Connect' }` — hardcoded English
  - T-11 defaults: `confirmLabel = 'Confirm'`, `cancelLabel = 'Cancel'`
  - Review checklist: "LLD specifies i18n namespace for each new component"
- **Recommendation:** Add an i18n section to T-10 and T-11 specifying:
  - Namespace: `sharepoint` (or `connectors`) under `studio.json`
  - Key plan for all tab labels, status strings, action menu items, button labels, placeholder text
  - Use `useTranslations('studio')` with `t('sharepoint.tabs.connect')` pattern
  - All default strings in T-11 (`confirmLabel`, `cancelLabel`) should use translation keys

---

### Finding F-07: T-10 More Actions stubs use console.log — violates no-console rule

- **Task:** T-10
- **Severity:** MEDIUM
- **Location:** T-10 ST-10.2
- **Issue:** The LLD specifies stub More Actions items with `console.log` / `toast.info('Not implemented')`. The CLAUDE.md rule states: "Never `console.log` in server code." While this is frontend code (not server), using `console.log` as a stub is still a bad pattern. More importantly, the review checklist states: "No stub endpoints — if logic not ready, LLD must specify 501 response." The equivalent for frontend is to not ship non-functional menu items.
- **Evidence:**
  - T-10 ST-10.2: "All items are stubs (placeholder `console.log` / `toast.info('Not implemented')`) for Wave 1"
- **Recommendation:** Either (a) disable/hide menu items that have no implementation yet (preferred — don't show what doesn't work), or (b) use only `toast.info` (not `console.log`) with a clear "Coming in Wave N" message. Remove `console.log` from the spec.

---

### Finding F-08: T-08 useConnector hook does not specify SWR cache invalidation after mutations

- **Task:** T-08
- **Severity:** MEDIUM
- **Location:** T-08 Hook Signatures
- **Issue:** The review checklist requires: "LLD specifies SWR cache invalidation strategy after mutations (`mutate()` calls)." The `useConnector` hook exposes `mutate()` but the LLD does not specify when/where `mutate()` should be called after connector operations (e.g., after auth completes, after config update, after sync start). The `useConnectorSync` hook also doesn't specify how it coordinates with `useConnector` — when sync completes, the connector detail should also refresh.
- **Evidence:**
  - Review checklist: "LLD specifies SWR cache invalidation strategy after mutations"
  - T-08: only type signatures are specified, no mutation/invalidation flow
- **Recommendation:** Add a "Cache Invalidation Strategy" section to T-08 documenting:
  - After auth completion: call `useConnector.mutate()`
  - After config change: call `useConnector.mutate()` + `useConnectorList.mutate()`
  - After sync start/stop/pause/resume: call `useConnectorSync.mutate()` + `useConnector.mutate()`
  - After sync completes (detected by polling): auto-revalidate `useConnector`

---

### Finding F-09: T-03 Redis key rename from oauth:device: to oauth:state: is a breaking change

- **Task:** T-03
- **Severity:** MEDIUM
- **Location:** T-03 ST-03.2
- **Issue:** Renaming the Redis key prefix from `oauth:device:` to `oauth:state:` will break any in-flight OAuth sessions stored under the old prefix. Users in the middle of device code or authorization code flows will lose their sessions.
- **Evidence:**
  - T-03 ST-03.2: "change `oauth:device:` to `oauth:state:` to be auth-method-agnostic"
  - Device code sessions have TTL (short-lived), so window of breakage is limited
- **Recommendation:** Either (a) keep the old prefix (cosmetic rename is low value for the risk), or (b) add a brief transition period where `getDeviceCodeSession()` checks both prefixes (old first, then new), and `storeDeviceCodeSession()` writes to the new prefix. Given the short TTL of these sessions, option (a) is simpler.

---

### Finding F-10: T-06 audit service does not specify how actor email is resolved from request

- **Task:** T-06
- **Severity:** MEDIUM
- **Location:** T-06 Service Signatures
- **Issue:** The `writeAuditEntry()` function takes `actor: string` (email or "system"). The route handler must extract the user's email from the authenticated request. The LLD does not specify how this is done. The auth middleware uses `createUnifiedAuthMiddleware` which sets `req.tenantContext`. The LLD should specify whether the actor comes from `req.tenantContext.userId`, `req.tenantContext.email`, or another source.
- **Evidence:**
  - T-06 service: `actor: string; // email or "system"`
  - Route handlers need to resolve this from the request context
- **Recommendation:** Add a note to ST-06.3 specifying: "Extract `actor` from `req.tenantContext!.email ?? req.tenantContext!.userId ?? 'unknown'`." Verify the actual fields available on `tenantContext` by reading the auth middleware types.

---

### Finding F-11: T-05 in-memory Map specified but missing explicit TTL

- **Task:** T-05
- **Severity:** LOW
- **Location:** T-05 ST-05.6
- **Issue:** The LLD correctly identifies the need for an in-memory Map with max size (10,000) and LRU eviction per CLAUDE.md rules. However, it does not specify a TTL. The Map is described as "for the duration of the crawl" which provides natural cleanup, but if a crawl runs for hours, stale entries could be an issue if Azure AD group memberships change during the crawl.
- **Evidence:**
  - T-05 ST-05.6: "in-memory Map with TTL/max-size per CLAUDE.md rules — max 10,000 entries, evicted LRU"
  - CLAUDE.md: "Every in-memory Map needs max size, TTL, and eviction"
- **Recommendation:** Add explicit TTL (e.g., 1 hour) to the Map entries. This is a minor gap since the Map is scoped to a single crawl run.

---

### Finding F-12: T-02 pauseSync() does not include Redis cancel signal in the LLD service signature diff

- **Task:** T-02
- **Severity:** LOW
- **Location:** T-02 Function Signatures, "After" section
- **Issue:** The "After" service-layer signature for `pauseSync()` is identical to the "Before" signature. The only difference is a comment: "Now also publishes Redis cancel signal to stop in-flight sync." The actual code change (adding Redis publish) is only described in ST-02.2, not reflected in the signature diff. This is not a bug but makes the LLD less clear about what changes.
- **Evidence:**
  - T-02 Before and After: Same function signature with only a comment difference
- **Recommendation:** No action needed — the change is behavioral, not in the signature. Just noting for clarity.

---

### Finding F-13: Existing connector routes use authMiddleware (createUnifiedAuthMiddleware) — confirmed compliant

- **Task:** T-06, T-07 (new routes)
- **Severity:** INFO (no issue)
- **Location:** T-06 ST-06.3, T-07 ST-07.3
- **Issue:** The LLD correctly states new routes should use `authMiddleware` "already applied on the parent router." Verified: `connectors.ts` line 20 applies `router.use(authMiddleware)` which is backed by `createUnifiedAuthMiddleware` from `@agent-platform/shared-auth` (verified at `apps/search-ai/src/middleware/auth.ts` line 24). New route files mounted on this router will inherit the auth middleware. Compliant.
- **Evidence:** Confirmed by code inspection.
- **Recommendation:** None — compliant.

---

### Finding F-14: File overlap between T-01, T-02, T-03 on connector.service.ts — parallel execution risk

- **Task:** T-01, T-02, T-03
- **Severity:** MEDIUM
- **Location:** File Overlap Check section
- **Issue:** Three tasks modify `connector.service.ts` at different line ranges. The LLD acknowledges this and says "can be done in parallel as long as they do not run `prettier` concurrently." However, the Task Independence Matrix marks all three as fully parallelizable. The overlap analysis recommendation ("Run sequentially within the same file, or use separate branches merged with care") contradicts the matrix. For an implementer following the matrix, this could cause merge conflicts.
- **Evidence:**
  - Task Independence Matrix: T-01, T-02, T-03 all listed as "Can Parallel With" each other
  - File Overlap Check: "Recommendation: Run sequentially within the same file"
- **Recommendation:** Update the Task Independence Matrix to note that T-01, T-02, T-03 should be serialized on `connector.service.ts`. Alternatively, designate T-01 as the first to touch this file (it already blocks T-05), then T-02, then T-03.

---

## Summary

| Severity | Count |
| -------- | ----- |
| CRITICAL | 1     |
| HIGH     | 3     |
| MEDIUM   | 6     |
| LOW      | 2     |
| INFO     | 1     |

**VERDICT: NEEDS_FIXES**

### Critical fixes required before implementation

1. **F-01:** Remove the false route typo claim from T-02 (ST-02.1, AC-03, Problem section). The routes are correct. An implementer following this LLD would make a "fix" to code that doesn't need fixing.

### High fixes that should be addressed

2. **F-02:** Add Zod validation schemas to T-06 and T-07 route handlers.
3. **F-03:** Resolve the `projectId` source for new models — ConnectorConfig has no `projectId`.
4. **F-06:** Add i18n strategy for T-10 and T-11 frontend components.

### Verified compliant

- [x] Resource isolation: tenantId on every query (audit, version, connector queries all include tenantId)
- [x] Centralized auth: uses `createUnifiedAuthMiddleware` via `authMiddleware` (verified in code)
- [x] Stateless distributed: OAuth state already in Redis (T-03 correctly identified this)
- [x] Error handling: uses `{ success, data/error: { code, message } }` pattern (verified in connectors.ts)
- [x] Logger usage: `createLogger('module')` pattern (verified in connector.service.ts, connectors.ts)
- [x] Express route ordering: new routes are all under `/connectors/:id/...` paths (no static/parameterized conflict)
- [x] Model registration: T-04, T-06, T-07 all include `ModelRegistry.registerModelDefinition()` calls
- [x] tenantIsolationPlugin: T-06, T-07 both include `schema.plugin(tenantIsolationPlugin)`
- [x] Indexes: Both new models define compound indexes including tenantId (with caveats in F-04)
- [x] Task independence: T-05 correctly depends on T-01, T-10 correctly depends on T-08+T-09
