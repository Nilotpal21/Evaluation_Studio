# Studio → DB → DSL → Runtime Config Hardening

## Future-Ready Contract

Runtime `{{config.KEY}}` placeholders have two distinct resolution lanes:

- Project-wide placeholders resolve at compile/deploy or internal execution boundaries and fail closed when missing.
- Namespace-scoped tool binding placeholders stay unresolved until runtime execution, where the namespace-aware secrets provider resolves them against the tool's linked namespaces.

Studio must preserve config-backed numeric fields as either numbers or exact `{{config.KEY}}` placeholders through edit forms, validation, DSL serialization, persistence, deployment caching, and runtime execution.

## Slice Plan

1. Lock runtime config resolution parity with compiler behavior.
   - Preserve namespace-scoped binding placeholders.
   - Resolve and coerce unscoped binding placeholders from project config.
   - Reject deployment caching when unscoped config remains unresolved.

2. Lock Studio form round-trip support for runtime numeric values.
   - Expand shared form types and API schemas to accept exact config placeholders for numeric runtime fields.
   - Parse and serialize HTTP, sandbox, and workflow numeric config placeholders without `Number(...)` coercion.

3. Lock namespace warning validation on DSL changes.
   - Re-run placeholder namespace warnings whenever DSL changes, even if `variableNamespaceIds` is omitted.
   - Preserve existing namespaces unless the request explicitly updates them.

4. Lock secondary tool creation namespace defaults.
   - Apply the default variable namespace to ArchAI SearchAI tool creation.
   - Apply the default variable namespace to MCP discovery-created project tools.

## Test-Locking Approach

Each slice adds regression coverage at the nearest boundary:

- Runtime service and deployment route tests for config resolution and fail-closed behavior.
- Shared parser, serializer, and Zod schema tests for config-backed numeric fields.
- Studio route tests for DSL-only namespace warning changes.
- Studio service/tool-op tests for secondary tool creation namespace defaults.
