# Reusable Module E2E Audit Iteration 2: Required Config Key Preflight

Status: Implemented
Date: 2026-05-02
Jira: ABLP-51

## Audit Finding

Module release contracts can declare `requiredConfigKeys`, but runtime deployment only validates required environment variables, MCP servers, and auth profiles. Studio preview/import validates supplied `configOverrides`, but a consumer can import and deploy a dependency with a required config key missing entirely. If the key is not surfaced by a DSL placeholder in the mounted artifact, the module snapshot can materialize successfully while violating the module contract.

## Target Design

Deploy-time module snapshot materialization must treat required config keys as first-class prerequisites. A required key is satisfied when it exists in consumer project config variables or in the dependency `configOverrides`. Secret required keys must be supplied from project config variables only; secret values in dependency overrides should fail closed even if stale records were inserted before current Studio validation.

## Implementation Slices

- [x] Red test: missing required config keys block deployment snapshot creation.
- [x] Red test: required config keys are satisfied by project config or non-secret overrides, while secret overrides fail closed.
- [x] Green implementation: validate `requiredConfigKeys` after dependency resolution and project config loading, before snapshot creation.
- [x] Verification: run deployment-build-service focused tests.
- [x] Final verification: runtime package build.

## Future-Ready Contract

- Runtime is the final authority for module contract prerequisites.
- Studio warnings remain helpful guidance, but stale DB records cannot bypass deploy validation.
- The contract has a single interpretation across import, DB persistence, snapshot build, and runtime execution.
