# LLD: Reusable Module Runtime Identity Parity

**Status**: IMPLEMENTED
**Date**: 2026-05-03
**Audit Thread**: Studio -> DB -> DSL -> runtime execution for reusable project modules

## 1. Fresh Audit Finding

### GAP-001: Runtime alias rewrite ignored declared DSL identities

Reusable module release artifacts are stored by the Studio/DB artifact name, while compiled IR can carry the parsed DSL-declared agent name and tool definitions can carry their own declared names. The runtime deployment alias rewriter only mapped artifact keys, so a stored-name/declared-name drift could mount a snapshot entry at `alias__stored_name` while leaving `ir.metadata.name`, handoffs, delegates, or tool references pointed at the unmounted declared names.

### GAP-002: Deploy-time recompilation dropped standalone module tools

The deployment build service recompiles portable module artifacts from source when possible. In that path it only rebuilt tool definitions that were declared by an agent document, so a module tool could be present in the Studio-published release artifact and import contract but disappear from the mounted runtime snapshot when no agent referenced it directly.

### Impact

- Module snapshot keys and runtime IR identity could diverge.
- Cross-agent references inside an imported module could remain unaliased.
- Tool references could remain pointed at declared tool names even though mounted tools use `alias__artifact_key`.
- The bug is hidden unless a Studio record name and parsed DSL name differ, which the project metadata pipeline tracks but does not universally forbid.
- Standalone module tools could be visible in Studio/import planning but unavailable at runtime execution.

## 2. Future-Ready Contract

### Identity Domains

| Domain            | Example                 | Owner              | Runtime Role                                          |
| ----------------- | ----------------------- | ------------------ | ----------------------------------------------------- |
| Artifact key      | `stored_main`           | Studio/DB release  | Canonical portable source identity and provenance     |
| Declared DSL name | `DeclaredMain`          | Parsed/compiled IR | Compatibility alias for references inside compiled IR |
| Mounted name      | `payments__stored_main` | Runtime deployment | Only executable identity exposed to sessions          |

### Design Decisions

| #   | Decision                                                                                 | Rationale                                                                                                 |
| --- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| D-1 | Keep artifact keys as the canonical mounted/provenance identity.                         | This preserves existing release artifacts, contract naming, snapshot keys, and provenance semantics.      |
| D-2 | Treat declared agent/tool names as additional rewrite aliases, not new mounted symbols.  | Declared names affect IR references but should not create extra runtime entries or change consumer names. |
| D-3 | Fail closed when two source names would map to different mounted symbols.                | Ambiguous internal identity means deployment cannot safely rewrite references.                            |
| D-4 | Keep this as a runtime compatibility fix with no DB migration or artifact format change. | Existing releases can be repaired at deployment build time.                                               |
| D-5 | Mount every artifact tool after recompilation, even when no agent declares it.           | Release contracts and Studio import previews advertise all provided tools, not only tools used by agents. |

## 3. Implementation Plan

### Slice 1: Runtime Alias Identity Lock

1. Add a failing runtime test where artifact keys differ from declared agent/tool names.
2. Assert `ir.metadata.name`, handoff targets, agent tool references, tool definitions, and `renameMap` all resolve to mounted artifact-key names.
3. Enrich `rewriteModuleIR(...)` so the rename map includes artifact keys plus compiled agent `metadata.name` and tool definition `name`.
4. Add an ambiguity guard that throws before rewrite when source aliases conflict.
5. Run focused runtime tests, then package build before commit.

### Slice 2: Standalone Tool Mount Lock

1. Add a failing deployment-build test where a release artifact contains a tool not declared by the module agent DSL.
2. Assert the runtime rewrite receives that tool and the stored snapshot reports one mounted tool.
3. Reuse the same config-template resolution path for declared and standalone tools.
4. Preserve `resolvedToolImplementations` only for agent-declared tools so agent recompilation semantics stay unchanged.
5. Run focused runtime tests, then package build before commit.

## 4. Verification

- [x] Failing lock observed before implementation: `metadata.name` stayed `DeclaredMain`.
- [x] Failing lock observed before implementation: standalone artifact tool mounted count stayed `0`.
- [x] `pnpm --dir apps/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/services/modules/__tests__/module-alias-rewriter.test.ts` (`54/54`)
- [x] `pnpm --dir apps/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/services/modules/__tests__/deployment-build-service.test.ts --testNamePattern "standalone artifact tools"` (`1/1`)
- [x] `pnpm build --filter=@agent-platform/runtime`
- [x] `pnpm --dir apps/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/services/modules/__tests__/deployment-build-service.test.ts src/services/modules/__tests__/module-alias-rewriter.test.ts` (`86/86`)

## 5. Rollback

Revert the runtime alias rewriter slice. No data migration or artifact rewrite is required because the change only enriches deploy-time rewrite behavior.
