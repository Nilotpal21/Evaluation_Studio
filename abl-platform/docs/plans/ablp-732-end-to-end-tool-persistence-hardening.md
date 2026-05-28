# ABLP-732 End-to-End Tool Persistence Hardening

## Goal

Make the Studio -> DB -> DSL -> runtime execution path fail closed for every ProjectTool write path, not only the primary Studio editor route.

## Remaining Hidden Risks

| Risk                                                                                 | Impact                                                                                                                          | Design Response                                                                                                 |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `.tools.abl` file-level defaults are lost when Project IO stores standalone tool DSL | Valid imports with `base_url`, `auth`, `headers`, or retry defaults become invalid or execute against the wrong runtime binding | Materialize file defaults into each stored standalone ProjectTool DSL before hashing and persistence validation |
| Runtime cache keys trust persisted `sourceHash`                                      | A stale DB hash can reuse an old compiled Redis binding even when `dslContent` changed                                          | Treat runtime cache identity as derived from current `dslContent`, not from persisted `sourceHash`              |
| Internal workflow tool execution uses a legacy loader                                | Bad historical DB rows can bypass the primary resolver and reach runtime execution                                              | Run the shared persistence guard inside `loadProjectToolsAsIR()` before building IR                             |
| Repository helpers accept caller-provided `sourceHash` and independent DB/DSL fields | Future callers can reintroduce name/type/hash drift after route-level fixes                                                     | Move derived-hash and DB/DSL consistency enforcement into `createProjectTool()` / `updateProjectTool()`         |
| Malformed signature parameter fragments are silently ignored                         | Saved runtime schema can drop parameters the author intended to require                                                         | Make persistence validation reject malformed parameter fragments                                                |
| SearchAI is runtime-supported but not a first-class typed Studio tool                | SearchAI remains a raw/special path and cannot round-trip cleanly through typed form serialization                              | Add SearchAI typed schema, serializer, and parser support while keeping `tenant_id` server-derived              |

## Second-Pass Review Findings

| Finding                                                             | Impact                                                                                            | Design Response                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| SearchAI auto-registration owns tools by generated name only        | KB registration can overwrite user tools or delete another KB's tool after a truncation collision | Scope updates/deletes by `toolType: searchai` and embedded `index_id`, and add a deterministic suffix on truncation |
| Version creation trusts persisted ProjectTool `sourceHash`          | Legacy stale hashes can deduplicate an agent version even when current tool DSL changed           | Derive snapshot hashes from current `dslContent` immediately before version hash calculation                        |
| Project tool resolution errors are warnings before version/preview  | Agents can be deployed with unresolved authored project tools and fail later at execution time    | Treat resolver errors as blocking for version creation and working-copy compile                                     |
| Runtime workflow loader validates shape but not referential binding | Raw imports can persist missing workflow/trigger/version references until runtime execution       | Reuse `validateWorkflowToolBinding()` in `loadProjectToolsAsIR()` and fail closed for bad historical records        |
| Workflow tool type is missing from release/version type contracts   | Generated clients and stricter serializers can reject or drop valid workflow tools                | Derive snapshot/artifact type unions from the canonical ProjectTool type set where packages can safely import it    |

## Third-Pass Review Findings

| Finding                                                          | Impact                                                                                                          | Design Response                                                                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| SearchAI bindings can cross project boundaries                   | A same-tenant ProjectTool can reference another project's SearchIndex and execute with tenant-only runtime auth | Carry project scope into Runtime -> SearchAI tokens, enforce project-aware ownership in SearchAI runtime, and validate at save |
| Workflow refs compile structurally without referential DB checks | Raw workflow imports/updates and version resolution can persist missing workflow/trigger/version refs           | Reuse async workflow binding validation in Studio raw paths and shared version-time tool resolution                            |
| Peer-agent tools bypass fail-closed version resolution           | A target agent version can compile/cache peer IR where peer authored tools are unresolved                       | Build the tool resolution map from every document included in the version compile, not only the target agent                   |

## Design Decisions

| Decision                                                                        | Rationale                                                                                                                                   |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Centralize ProjectTool persistence validation in `@agent-platform/shared/tools` | Studio, runtime import, project-io, and future authoring surfaces need one contract for name/type/DSL/hash consistency.                     |
| Treat `sourceHash` as derived data                                              | Callers should not be able to persist a hash that was computed from a wrapper file or stale DSL.                                            |
| Validate imports before apply                                                   | Project imports should fail during plan/preview instead of partially writing bad tools and deferring failure to runtime.                    |
| Runtime remains defensive                                                       | Old records may already exist, so runtime resolution must refuse DB/DSL drift and avoid cache collisions even after save-time guards exist. |
| Materialize wrapper defaults at import boundaries                               | `project_tools.dslContent` is intentionally standalone; defaults from wrapper files must become explicit before DB storage.                 |
| Keep server-derived tenant fields out of Studio request bodies                  | SearchAI DSL needs `tenant_id`, but the API should derive it from auth context instead of trusting client input.                            |
| Treat project scope as part of SearchAI binding identity                        | SearchIndex ownership is tenant + project; runtime caches and internal JWTs must preserve both dimensions.                                  |
| Run referential checks before any version/runtime cache write                   | Invalid workflow/SearchAI bindings should never enter compiled IR, version snapshots, or per-session tool executors.                        |

## Test-Locking Slices

1. Project-io extraction: workflow type parity, optional-return signatures, and per-tool `sourceHash`.
2. Shared persistence guard: signature name, DSL `type`, type-specific validation, and canonical hash generation.
3. Project import planning: reject invalid imported tools before adapter writes to MongoDB.
4. Runtime resolution: cache/compile by ProjectTool identity, not only `sourceHash`, and fail closed on persisted DB/DSL drift.
5. Studio secondary write paths: duplicate/raw creation reuse the same shared guard before persistence.
6. Project-io default materialization: wrapper-level HTTP defaults become explicit standalone DSL before hashing.
7. Runtime cache hardening: cache lookup/write uses the hash derived from current `dslContent`.
8. Internal runtime loader hardening: workflow/internal tool execution refuses invalid ProjectTool DSL before IR build.
9. Repository persistence hardening: repo helpers derive hashes, validate DSL/name/type, and rewrite rename-only updates.
10. Signature parser strictness: malformed parameter fragments are rejected before persistence.
11. SearchAI typed parity: backend typed create/serialize/parse support is available without trusting client-supplied tenant IDs.
12. SearchAI ownership hardening: auto-registration upserts/deletes only SearchAI tools bound to the same index and uses collision-resistant names.
13. Version snapshot hash hardening: agent version hashes use hashes derived from current ProjectTool DSL, not persisted hashes.
14. Fail-closed compile gates: version creation and working-copy compile reject unresolved authored ProjectTool references.
15. Workflow referential gate: runtime raw loader validates workflow, version, and trigger references before exposing workflow bindings.
16. Tool type contract parity: workflow appears in version snapshots, runtime response schemas, Studio version clients, and module release artifacts.
17. SearchAI project-scope locking: middleware cache key, internal tokens, Studio import/update, and shared resolver all require same-project indexes.
18. Workflow referential locking: raw Studio updates/imports and shared version resolver reject missing workflow/trigger/version records.
19. Peer-agent version locking: version creation resolves tools for every compiled agent document before snapshotting or caching IR.

## Acceptance Criteria

- Multi-tool `.tools.abl` imports produce distinct hashes per stored tool DSL.
- `workflow` and `searchai` imports run through the same save-time DSL validation as Studio raw JSON import.
- Optional-return tool signatures are stored as standalone signature-first DSL, never as a full `TOOLS:` wrapper.
- Runtime never registers a tool when DB `name` / `toolType` disagrees with persisted DSL.
- Runtime does not collapse two distinct tools that temporarily share a legacy `sourceHash`.
- Project IO imports with `base_url` + relative `endpoint` store executable absolute endpoints.
- Runtime ignores stale persisted `sourceHash` for cache identity and compiles against current `dslContent`.
- `/api/internal/tools/execute` cannot execute invalid SearchAI/workflow bindings through the legacy loader.
- Repository helpers prevent direct callers from writing stale hashes or rename-only DB/DSL drift.
- Invalid parameter syntax such as `city string` is rejected instead of silently dropping the parameter.
- SearchAI tools can be created from typed backend payloads and round-trip through shared serializer/parser helpers.
- SearchAI KB registration cannot overwrite/delete non-SearchAI tools or SearchAI tools bound to a different index.
- Two long KB slugs that share the first 64 characters generate distinct tool names.
- Agent version snapshots recompute tool hashes from current DSL and preserve workflow tool snapshots.
- Missing authored ProjectTools block version creation and working-copy compile.
- Runtime workflow IR loading rejects missing workflow/trigger/version references before execution.
- Workflow tools are accepted by version/module release type contracts.
- SearchAI runtime ownership cache cannot reuse a verified index across projects in the same tenant.
- SearchAI typed/raw Studio saves reject indexes outside the project before ProjectTool persistence.
- Version creation fails closed when any peer agent in the compiled document set references a missing authored ProjectTool.
