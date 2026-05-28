# Reusable Module E2E Audit Iteration 3: Connector Prerequisite Preflight

Status: Implemented
Date: 2026-05-02
Jira: ABLP-51

## Audit Finding

The module contract includes `requiredConnectors`, and Studio preview/upgrade surfaces connector requirements as warnings. Runtime deployment snapshot materialization, however, only blocks on env vars, MCP servers, auth profiles, and config keys. A project can therefore deploy a module whose contract requires a connector even when no active connector binding exists for the consuming project.

## Target Design

Runtime deployment must validate connector prerequisites from the frozen module release contract before creating a `DeploymentModuleSnapshot`. A required connector is satisfied by an active `ConnectorConnection` in the same tenant and consumer project with the matching `connectorName`. Missing or inactive connectors should produce blocking diagnostics and prevent snapshot creation.

## Implementation Slices

- [x] Red test: missing required connector blocks deployment snapshot creation.
- [x] Red test: active connector binding satisfies the module contract.
- [x] Green implementation: extend deployment prerequisite validation to query `ConnectorConnection`.
- [x] Verification: run deployment-build-service focused tests.

## Future-Ready Contract

- Studio warnings are advisory, but runtime deployment remains fail-closed.
- The connector check is scoped by tenant and consumer project, preserving resource isolation.
- The same prerequisite surface can later be extended to distinguish tenant-scoped, user-scoped, and environment-specific connector policies without changing snapshot consumers.
