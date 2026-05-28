# LLD: Export Surface Canonical Parity Hardening

**Related Audit Context**: 2026-05-03 Studio -> DB -> DSL -> Runtime execution export/status audit
**Related Plans**:

- `docs/plans/2026-05-02-companion-tail-parity-hardening.lld.md`
- `docs/plans/2026-05-02-action-handler-end-to-end-hardening.lld.md`
- `docs/plans/2026-05-02-studio-arch-routing-parity-hardening.lld.md`
  **Status**: DONE
  **Date**: 2026-05-03

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                            | Rationale                                                                                         | Alternatives Rejected                                                                  |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| D-1 | Treat the v2 layered export contract as the single canonical export surface for runtime and Studio. | Public runtime export, Studio export preview, and git status must describe the same file family.  | Keeping a legacy runtime export path guarantees more silent drift.                     |
| D-2 | Move layer metadata and default assembler construction into `@agent-platform/project-io`.           | Layer counts and layer selection rules should not be reimplemented in route-local code.           | Copying layer factories and counts per route will drift again as new layers are added. |
| D-3 | Make git status explicit about which layers are included by default in git sync.                    | The settings surface should reflect the actual push payload, not just agent hashes.               | Showing raw agents/locales only hides most tracked files and keeps operators misled.   |
| D-4 | Preserve preview dependency detail while expanding to canonical layer metadata.                     | Export preview still needs dependency validation, but layer coverage must come from the same seam | Replacing dependency preview with counts alone would regress useful diagnostics.       |
| D-5 | Keep Studio lazy-loading behavior but delegate assembler ownership to the shared project-io seam.   | Studio should avoid route-local heavy imports without owning a divergent assembler registry.      | Importing assemblers from Studio-only helpers in runtime would create cross-app drift. |

### Canonical Export Surface Contract

The following surfaces must agree on the canonical v2 export contract:

1. Runtime public `GET /api/projects/:projectId/project-io/export`
2. Runtime public `GET /api/projects/:projectId/project-io/export/preview`
3. Studio `POST /api/projects/:id/export/preview`
4. Studio `GET /api/projects/:id/git/status`
5. Studio git push/export routes that already emit canonical layered files

### Shared Seams

| Seam                                               | Responsibility                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `buildDefaultAssemblerMap()`                       | Build the canonical `LayerName -> LayerAssembler` registry in one place        |
| `buildLayerPreview()`                              | Return per-layer counts + default modes using the canonical assembler contract |
| `resolveLayers()`                                  | Decide which layers are exported by default                                    |
| `GitStatusResponse.localLayers + defaultLayers`    | Reflect the actual git-managed export payload in Studio settings               |
| Runtime / Studio preview response `layers` payload | Describe full v2 layer coverage instead of hand-counted subsets                |

---

## 2. File-Level Change Map

### New Files

| File                                                                       | Purpose                                                          | LOC Estimate |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------ |
| `packages/project-io/src/export/layer-preview.ts`                          | Shared builder + preview helpers for canonical layer metadata    | 140          |
| `packages/project-io/src/__tests__/layer-preview.test.ts`                  | Lock shared builder/preview behavior                             | 160          |
| `apps/studio/src/__tests__/api-routes/api-export-preview-route.test.ts`    | Lock Studio export preview onto canonical layer metadata         | 180          |
| `apps/studio/src/__tests__/api-routes/api-git-status-route.test.ts`        | Lock git status onto canonical local layer coverage              | 180          |
| `apps/studio/src/__tests__/components/git-integration-tab-status.test.tsx` | Lock the settings surface onto the new git-managed layer summary | 160          |

### Modified Files

| File                                                                     | Change Description                                                          | Risk   |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------ |
| `docs/plans/2026-05-03-export-surface-canonical-parity-hardening.lld.md` | This implementation plan                                                    | Low    |
| `packages/project-io/src/export/index.ts`                                | Export canonical layer preview/builder helpers                              | Low    |
| `apps/studio/src/lib/export-assemblers.ts`                               | Delegate to the shared project-io builder instead of owning factories       | Medium |
| `apps/runtime/src/routes/project-io.ts`                                  | Replace legacy export path with canonical v2 export + v2 preview metadata   | High   |
| `apps/runtime/src/__tests__/project-io-routes.test.ts`                   | Lock runtime public export/preview to the canonical v2 layered contract     | High   |
| `apps/studio/src/app/api/projects/[id]/export/preview/route.ts`          | Use shared layer preview metadata and canonical dependency inputs           | Medium |
| `apps/studio/src/app/api/projects/[id]/git/status/route.ts`              | Report canonical local layers/default layers for git-managed export payload | Medium |
| `apps/studio/src/api/project-io.ts`                                      | Extend preview and git-status client types with canonical layer metadata    | Medium |
| `apps/studio/src/components/settings/GitIntegrationTab.tsx`              | Render git-managed layer summary in the settings surface                    | Medium |
| `packages/i18n/locales/en/studio.json`                                   | Add labels for git-managed layer status                                     | Low    |

---

## 3. Implementation Phases

### Phase 1: Shared Layer Metadata Seam

**Goal**: Create one shared source of truth for layer factories and preview counts.

**Tasks**:

1. Add failing `project-io` tests for canonical assembler-map creation and per-layer preview metadata
2. Introduce `buildDefaultAssemblerMap()` in `packages/project-io`
3. Introduce `buildLayerPreview()` that counts layers via canonical assemblers
4. Re-export the new helper(s) from `@agent-platform/project-io/export`
5. Make Studio’s lazy assembler helper delegate to the shared builder

**Exit Criteria**:

- [x] One shared builder exists for canonical layer assemblers
- [x] One shared helper exists for canonical layer preview counts
- [x] `packages/project-io` tests pass for the new helper seam

**Rollback**: Restore route-local assembler registries and route-local layer counting.

---

### Phase 2: Runtime Public Export / Preview Parity

**Goal**: Make the runtime public project-io export surface fully canonical and integrity-safe.

**Tasks**:

1. Add failing runtime route tests for v2 layer metadata and sealed MCP output
2. Replace legacy `exportProject()` usage with `exportProjectV2()`
3. Stop appending MCP files after export orchestration completes
4. Add layer and DSL-format query parsing parity for runtime public export
5. Expand runtime preview response to include `profiles`, `layers`, and `defaultLayers`
6. Align runtime preview dependency schema with canonical dependency validation fields

**Exit Criteria**:

- [x] Runtime public export uses the canonical v2 layered exporter
- [x] Runtime public export no longer mutates files after lockfile/manifest generation
- [x] Runtime preview returns canonical layer metadata
- [x] Runtime route tests pass for the new export/preview contract

**Rollback**: Revert runtime route to legacy exportProject-based export and preview payloads.

---

### Phase 3: Studio Preview / Git Surface Parity

**Goal**: Make Studio preview and git status describe the same canonical export footprint already used by git push.

**Tasks**:

1. Add failing Studio route tests for export preview and git status canonical layer payloads
2. Switch Studio export preview to use the shared layer preview seam
3. Pass behavior-profile names into dependency graph construction for preview parity
4. Extend git status with canonical `localLayers` and `defaultLayers`
5. Update client types and settings UI to render git-managed layer coverage
6. Add a focused component lock for the new git-managed layers summary

**Exit Criteria**:

- [x] Studio export preview returns canonical layer counts/defaults
- [x] Studio git status exposes the actual git-managed layer footprint
- [x] The settings tab renders the new git-managed layer summary
- [x] Focused Studio route/component tests pass

**Rollback**: Revert Studio routes and settings UI to the legacy agent/locales-only status model.

---

## 4. Wiring Checklist

- [x] Runtime public export route imports the shared project-io assembler/preview seam
- [x] Runtime public preview response schema matches the returned payload
- [x] Studio export route helper delegates to the shared builder
- [x] Studio export preview route uses the shared layer preview helper
- [x] Studio git status route reports canonical local layers/default layers
- [x] Studio settings UI renders the new git-managed layer payload

---

## 5. Acceptance Criteria

- [x] The new shared layer preview seam is the only assembler/count authority touched in this slice
- [x] Runtime and Studio surfaces agree on canonical layer names and default modes
- [x] No export path appends files after manifest/lockfile generation in the audited runtime public lane
- [x] Git status now surfaces the actual default git-managed export layers
- [x] Tests were added before code per slice and the affected packages were built before focused tests

## 6. Verification Notes

- `pnpm build --filter=@agent-platform/project-io`
- `pnpm --filter @agent-platform/project-io exec vitest run src/__tests__/layer-preview.test.ts`
- `pnpm build --filter=@agent-platform/runtime`
- `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/project-io-routes.test.ts`
- `pnpm --filter @agent-platform/studio exec tsc --noEmit`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-export-preview-route.test.ts src/__tests__/api-routes/api-git-status-route.test.ts src/__tests__/components/git-integration-tab-status.test.tsx`
- `pnpm --filter @agent-platform/studio build` is still blocked by an unrelated concurrent `next build` process in the shared worktree.
