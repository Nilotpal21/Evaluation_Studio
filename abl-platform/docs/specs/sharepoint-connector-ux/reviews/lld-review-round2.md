# LLD Review Round 2: Pattern Consistency + Fix Verification

**Document:** `docs/specs/sharepoint-connector-ux/wave1.lld.md`
**HLD Reference:** `docs/specs/sharepoint-connector-ux/sharepoint-connector-ux.hld.md`
**Reviewer:** lld-reviewer agent
**Date:** 2026-03-24
**Focus:** Pattern consistency against actual codebase + R1 fix verification

---

## Part A: Fix Verification

| R1 ID | Severity | Issue                                        | Fixed? | Notes                                                                                                                                                                                                                                          |
| ----- | -------- | -------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01  | CRITICAL | False route typo claim in T-02               | YES    | ST-02.1 no longer references a route typo. The subtask now correctly focuses on adding a Redis cancel signal to `pauseSync()`. Problem section updated.                                                                                        |
| F-02  | HIGH     | Missing Zod validation on T-06, T-07 routes  | YES    | Both T-06 (lines 467-479) and T-07 (lines 634-643) now include explicit Zod schemas: `connectorIdParam`, `auditLogQuery`, `exportFormatQuery`, `versionParams`, `diffQuery`. Uses `z.string().min(1)` for IDs.                                 |
| F-03  | HIGH     | New models require projectId but none exists | YES    | Both T-06 and T-07 models no longer include `projectId`. T-06 risk notes (line 525) and T-07 risk notes (line 688) explicitly state: "Connector scope is defined by tenantId + connectorId."                                                   |
| F-04  | MEDIUM   | Audit index missing tenantId lead            | YES    | T-06 primary index changed to `{ tenantId: 1, connectorId: 1, timestamp: -1 }` (line 419). Standalone `{ connectorId: 1, timestamp: -1 }` removed.                                                                                             |
| F-05  | MEDIUM   | Version auto-increment race condition        | YES    | T-07 risk notes (line 687) now explicitly document optimistic concurrency control via unique index. However, see new finding F2-03 below — the index definition and the risk notes text disagree on whether `tenantId` is in the unique index. |
| F-06  | HIGH     | No i18n strategy for T-10, T-11              | YES    | T-10 (lines 1047-1073) adds full i18n key plan under namespace `sharepoint`. T-11 (lines 1182-1190) adds keys. However, see new finding F2-01 below — the i18n hook usage pattern is incorrect.                                                |
| F-07  | MEDIUM   | console.log in More Actions stubs            | YES    | T-10 ST-10.2 (line 1083) now specifies unimplemented items as disabled with tooltip "Available in a future update". No `console.log` references remain.                                                                                        |
| F-08  | MEDIUM   | Missing SWR cache invalidation strategy      | YES    | T-08 now includes a "Cache Invalidation Strategy" section (lines 814-824) documenting mutation flows for auth, config, sync, and delete operations.                                                                                            |
| F-09  | MEDIUM   | Redis key rename breaking change             | YES    | T-03 ST-03.2 (line 234) now says "Keep existing `oauth:device:` prefix. Cosmetic rename is low value relative to the risk."                                                                                                                    |
| F-10  | MEDIUM   | Actor email resolution unspecified           | YES    | T-06 ST-06.3 (line 498) now specifies: `const actor = req.tenantContext?.email ?? req.tenantContext?.userId ?? 'system'` and `actorType` as `req.tenantContext ? 'user' : 'system'`.                                                           |
| F-11  | LOW      | In-memory Map missing explicit TTL           | YES    | T-05 ST-05.6 (line 333) now specifies "1-hour TTL per entry, LRU eviction" for the group ID cache.                                                                                                                                             |
| F-12  | LOW      | pauseSync() signature diff is no-op          | N/A    | Informational — no fix required per R1 recommendation.                                                                                                                                                                                         |
| F-13  | INFO     | Auth middleware compliance confirmed         | N/A    | Informational — no fix required.                                                                                                                                                                                                               |
| F-14  | MEDIUM   | File overlap contradicts task independence   | YES    | Task Independence Matrix (lines 1262-1287) now serializes T-01 -> T-02 -> T-03 on `connector.service.ts`. Matrix, overlap analysis, and recommended batches are all consistent.                                                                |

**Fix Verification Summary:** All 10 actionable findings from Round 1 have been addressed. 3 fixes introduce minor new issues detailed below.

---

## Part B: Pattern Consistency Findings

### Finding F2-01: i18n hook pattern incorrect — `useTranslations('studio')` does not exist in codebase

- **Task:** T-10, T-11
- **Severity:** HIGH
- **Location:** T-10 line 1073
- **Issue:** The LLD specifies `const { t } = useTranslations('studio');` then `t('sharepoint.tabs.connect')`. The actual codebase pattern (verified in 10+ search-ai components) is `const t = useTranslations('search_ai.sharepoint');` then `t('tabs.connect')`. The i18n library is `next-intl` (not a custom hook), the namespace segments map to nested keys in `packages/i18n/locales/en/studio.json` under the `search_ai` top-level key, and the destructured form `{ t }` should be just `t` (the hook returns the function directly, not an object).
- **Evidence:**
  - Codebase pattern: `const t = useTranslations('search_ai.vocabulary');` in `VocabularyTestPanel.tsx`
  - Codebase pattern: `const t = useTranslations('search_ai.crawl_intelligence');` in `CrawlIntelligencePanel.tsx`
  - LLD (line 1073): `const { t } = useTranslations('studio');` — wrong namespace, wrong destructuring
- **Fix:** Change to `const t = useTranslations('search_ai.sharepoint');` in T-10 and `const t = useTranslations('search_ai.type_to_confirm');` (or pass translated strings from parent) in T-11. Update all key references: `t('sharepoint.tabs.connect')` becomes `t('tabs.connect')`.

---

### Finding F2-02: T-07 ConnectorConfigVersion indexes missing tenantId prefix (same as R1 F-04 but for versions)

- **Task:** T-07
- **Severity:** MEDIUM
- **Location:** T-07 lines 587-589
- **Issue:** R1 F-04 was fixed for the audit model, but the same issue persists in the `ConnectorConfigVersion` model. Two of the three indexes lack `tenantId`:
  - `{ connectorId: 1, version: -1 }` — Should be `{ tenantId: 1, connectorId: 1, version: -1 }`
  - `{ connectorId: 1, version: 1 }, { unique: true }` — Should be `{ tenantId: 1, connectorId: 1, version: 1 }, { unique: true }`

  With `tenantIsolationPlugin` active, all queries include `tenantId` in the filter. Indexes without `tenantId` as prefix won't be used efficiently. The risk notes at line 687 already reference `{ tenantId, connectorId, version }` as the unique index, but the actual schema definition at line 588 omits `tenantId`.

- **Evidence:**
  - Line 587: `ConnectorConfigVersionSchema.index({ connectorId: 1, version: -1 });`
  - Line 588: `ConnectorConfigVersionSchema.index({ connectorId: 1, version: 1 }, { unique: true });`
  - Line 687 (risk notes): "unique compound index `{ tenantId, connectorId, version }`" — contradicts line 588
  - Existing pattern in `connector-config.model.ts`: All indexes lead with `tenantId` (lines 375-378)
- **Fix:**
  ```
  ConnectorConfigVersionSchema.index({ tenantId: 1, connectorId: 1, version: -1 });
  ConnectorConfigVersionSchema.index({ tenantId: 1, connectorId: 1, version: 1 }, { unique: true });
  ```
  Remove the third index `{ tenantId: 1, connectorId: 1 }` (line 589) since it's now a prefix of both other indexes.

---

### Finding F2-03: T-06 model export pattern does not match existing models

- **Task:** T-06
- **Severity:** MEDIUM
- **Location:** T-06 Model Schema (line 428 ends before export)
- **Issue:** The T-06 model schema code block ends with `ModelRegistry.registerModelDefinition(...)` but does not show the actual model export. Existing models follow a specific export pattern:
  ```ts
  export const ConnectorConfig =
    (mongoose.models.ConnectorConfig as mongoose.Model<IConnectorConfig>) ||
    model<IConnectorConfig>('ConnectorConfig', ConnectorConfigSchema);
  ```
  The `mongoose.models.X as ...` fallback is required to prevent "Cannot overwrite model" errors in hot-reload scenarios. The LLD should include this export pattern explicitly for both T-06 and T-07 to avoid implementers using a simple `model()` call.
- **Evidence:**
  - `connector-config.model.ts` lines 391-393: Uses `mongoose.models.X || model<X>(...)` pattern
  - `audit-log.model.ts` lines 67-68: Same pattern
  - T-06 code block: Ends at `ModelRegistry.registerModelDefinition(...)` — no export shown
  - T-07 code block: Same — ends at `ModelRegistry.registerModelDefinition(...)`, no export shown
- **Fix:** Add to both T-06 and T-07 model schemas:
  ```ts
  export const ConnectorAuditEntry =
    (mongoose.models.ConnectorAuditEntry as mongoose.Model<IConnectorAuditEntry>) ||
    model<IConnectorAuditEntry>('ConnectorAuditEntry', ConnectorAuditEntrySchema);
  ```

---

### Finding F2-04: T-06/T-07 route error handling should use existing `handleError` pattern

- **Task:** T-06, T-07
- **Severity:** MEDIUM
- **Location:** T-06 ST-06.3, T-07 ST-07.3
- **Issue:** The existing `connectors.ts` routes (lines 23-37) define a reusable `handleError()` function that maps `ConnectorError` to HTTP responses, logs unexpected errors with the logger, and uses the standard `{ success: false, error: { code, message } }` format. The LLD's new route files should reuse this pattern (either by extracting it to a shared module or duplicating it). The LLD does not specify the error handling approach for the new route files.
- **Evidence:**
  - `connectors.ts` lines 23-37: `handleError(res, error, fallbackCode)` with `ConnectorError` instance check
  - T-06 route definitions: Describe routes but no error handling pattern specified
  - T-07 route definitions: Same
- **Fix:** Add to T-06 ST-06.3 and T-07 ST-07.3: "Follow the `handleError()` pattern from `connectors.ts` (lines 23-37). Either extract it to a shared utility or replicate the `ConnectorError`-aware error handler in each route file."

---

### Finding F2-05: T-08 SWR hooks should return `mutate` with proper type, not `() => void`

- **Task:** T-08
- **Severity:** LOW
- **Location:** T-08 Hook Signatures (lines 756-757)
- **Issue:** The `UseConnectorReturn` interface types `mutate` as `() => void`. The actual SWR `mutate()` returns `Promise<Data | undefined>`. The `useKnowledgeBase` hook (the reference pattern) wraps it as `refresh: () => mutateKB()` which discards the return value. This is fine, but the LLD's Cache Invalidation Strategy (line 814-824) implies callers will chain mutate calls (e.g., "mutate useConnector + useConnectorList" after auth). If `mutate` is `() => void`, callers cannot await the revalidation. Consider using `() => Promise<void>` or returning the raw SWR `mutate` for advanced use.
- **Evidence:**
  - `useKnowledgeBase.ts` line 57: `refresh: () => mutateKB()` (returns void, matches LLD)
  - T-08 Cache Invalidation: "After auth completion -> mutate useConnector + useConnectorList"
- **Fix:** This is consistent with the existing `useKnowledgeBase` pattern (which also returns void). No change required unless the implementer needs `await`. Mark as informational — implementers should be aware.

---

### Finding F2-06: T-09 Zustand store does not follow atomic selector pattern

- **Task:** T-09
- **Severity:** LOW
- **Location:** T-09 Store Interface (lines 870-957)
- **Issue:** The review checklist requires "Zustand store usage follows atomic selector pattern (no inline objects)." The store itself is well-structured, but the LLD does not specify how consumers should select from the store. The `data-tab-filter-store.ts` reference pattern exports the store directly and consumers call `useDataTabFilterStore()` with no selector. For T-09, components will need multiple fields (e.g., `panelOpen`, `activeConnectorId`, `activeTab`). Without guidance, implementers may write `const { panelOpen, activeConnectorId, activeTab } = useConnectorStore()` which re-renders on any state change.
- **Evidence:**
  - `data-tab-filter-store.ts`: Simple store with 3 fields — inline destructuring is acceptable
  - T-09: 6 state fields + 6 actions — destructuring the whole store triggers unnecessary re-renders
- **Fix:** Add a note to T-09: "Consumers should use atomic selectors for frequently-changing state: `const panelOpen = useConnectorStore(s => s.panelOpen);`" This is advisory, not blocking.

---

### Finding F2-07: T-10 SlidePanel width override strategy should be explicit about Tailwind specificity

- **Task:** T-10
- **Severity:** LOW
- **Location:** T-10 Risk Notes (line 1117)
- **Issue:** The LLD proposes `className="!max-w-[720px]"` to override SlidePanel's width. The `!` prefix (Tailwind important) will work, but the SlidePanel component (line 67) applies `widthStyles[width]` after the `className` prop via `clsx(... widthStyles[width], className)`. Since `className` comes last in the `clsx` call, it will be appended after the default width class. Tailwind processes classes in source order when specificity is equal, so the `!max-w-[720px]` with the important flag should win. This is correct but fragile.
- **Evidence:**
  - `SlidePanel.tsx` line 67: `clsx('fixed... w-full...', widthStyles[width], className)`
  - Order: `widthStyles[width]` before `className` — `className` wins if using `!important`
- **Fix:** No change needed — the approach works. Just noting for implementer awareness. An alternative is to pass `width` as a new custom value, but that would require modifying the shared component which is unnecessary for Wave 1.

---

## Summary

| Severity | Count |
| -------- | ----- |
| HIGH     | 1     |
| MEDIUM   | 3     |
| LOW      | 3     |

**VERDICT: NEEDS_CHANGES**

### Must fix before implementation

1. **F2-01 (HIGH):** Fix the i18n hook pattern. Use `const t = useTranslations('search_ai.sharepoint')` not `const { t } = useTranslations('studio')`. Update all key references to drop the `sharepoint.` prefix (they become `t('tabs.connect')` etc.).

### Should fix

2. **F2-02 (MEDIUM):** Add `tenantId` prefix to ConnectorConfigVersion indexes and fix the mismatch between index definition and risk notes text.
3. **F2-03 (MEDIUM):** Add explicit model export pattern (`mongoose.models.X || model<X>(...)`) to T-06 and T-07 model code blocks.
4. **F2-04 (MEDIUM):** Specify error handling pattern for new route files — reuse `handleError()` from `connectors.ts`.

### Informational

5. **F2-05 (LOW):** `mutate` return type matches `useKnowledgeBase` pattern — no change needed.
6. **F2-06 (LOW):** Add advisory note about atomic selectors for T-09 store consumers.
7. **F2-07 (LOW):** SlidePanel width override approach is correct but fragile — no change needed.

### Verified compliant

- [x] **R1 fix verification:** All 10 actionable findings resolved
- [x] **Model patterns:** Schema definition style, plugin usage, index definitions, ModelRegistry calls follow `connector-config.model.ts` and `audit-log.model.ts` (with caveats in F2-02, F2-03)
- [x] **Route patterns:** Error response format, middleware chain, Zod validation all consistent with `connectors.ts`
- [x] **SWR hook patterns:** Conditional keys, return types, memoized values follow `useKnowledgeBase.ts`
- [x] **Zustand store patterns:** `create<State>((set, get) => ({...}))` follows `data-tab-filter-store.ts`
- [x] **Component patterns:** `SlidePanel`, `Tabs`, `DropdownMenu`, `Toggle`, `Input`, `Button` prop names verified against actual component interfaces
- [x] **Task independence:** T-01->T-02->T-03 serialization documented; file overlap analysis consistent with matrix
- [x] **Design system components verified:** DropdownMenu has `disabled` prop on items (line 51), Toggle has `checked`/`onChange` (line 13-14), Tabs uses `Tab` interface with `{id, label, icon?, count?}` (line 13-18)

### Notes for implementation

- The `TypeToConfirmInput` (T-11) is a UI-only component. Its i18n keys are under `search_ai.type_to_confirm` but since it receives all strings as props, the parent is responsible for translation. The LLD correctly notes this.
- T-10's tab locking UX (disabled tabs with lock icon) is not built into the `Tabs` component. The implementer will need to extend the `Tab` interface or add a wrapper. Flag this as a known extension point.
- The `DropdownMenuItem` component supports `disabled` prop natively (verified), so the "disabled with tooltip" pattern for unimplemented features will work, but wrapping a disabled `DropdownMenuItem` in a `Tooltip` may need attention since Radix tooltips on disabled elements require a wrapper `span`.
