# Runtime Config, Import, Git, and Provisioning Hardening Plan

## Target Contract

All project runtime configuration and project file synchronization entry points must enforce the same scoped references before data reaches MongoDB, DSL/IR previews, or runtime execution. A project that is valid in Studio must be valid through git webhook, manual git pull, runtime import, and direct runtime API writes; a project that is invalid must fail before persistence.

## Design

- Share runtime-config schema and async reference validation semantics across direct runtime writes, Studio import, git pull, webhook auto-sync, and runtime project-io import.
- Treat git `syncPath` as a canonical project scope internally, but pass provider root as `undefined` so GitHub, GitLab, and Bitbucket read repository root instead of a literal slash subtree.
- Keep export provisioning additive: combine DSL-discovered dependencies with DB-configured connectors and MCP servers so bundles announce every resource the destination may need.
- Validate tenant model references fail-closed with `{ tenantId, isActive: true, inferenceEnabled: true }` before persisting runtime config.

## Test-First Slices

1. Runtime project-io import validation
   - Lock preview and apply planner wiring with tests requiring `validateRuntimeConfigForSave`.
   - Reuse the same validator for runtime import that direct runtime writes use.

2. Git root sync path semantics
   - Lock default root pulls so providers receive `undefined`, while canonical paths remain unprefixed.
   - Preserve configured subdirectory sync by passing the normalized subpath and stripping it after pull.

3. Provisioning preview completeness
   - Lock export provisioning so DB-configured connectors and MCP servers are merged with DSL references.
   - Deduplicate and sort the merged result.

4. Direct runtime tenant model validation
   - Lock direct PUT validation for pipeline and filler tenant model refs.
   - Reject missing, inactive, or wrong-tenant refs before `ProjectRuntimeConfig.findOneAndUpdate`.

5. Webhook parity
   - Keep existing webhook route test asserting `syncPath`, tool binding validation, and runtime-config validation are passed to the canonical import planner.

## Verification

- Build affected packages before test execution.
- Run focused Vitest suites for project-io, runtime project-io routes, runtime-config route, and Studio webhook route.
- Run Prettier on all touched files before commit.
