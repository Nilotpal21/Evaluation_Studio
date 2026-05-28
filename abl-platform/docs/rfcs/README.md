# Agent Platform Split Feature Specs

This folder contains the split functional-spec and technical-design baseline aligned to the current codebase.

## Master Index

- [Master functional spec index](/docs/specs/MASTER_FUNCTIONAL_SPEC.md)

## Feature RFCs

- [F010 Evals and Quality Engineering](/docs/specs/rfcs/RFC-010-evals-quality-engineering.md)
- [F009 Guardrails and PII Safety](/docs/specs/rfcs/RFC-009-guardrails-pii-safety.md)
- [F003 Threaded Sessions and Memory](/docs/specs/rfcs/RFC-003-threaded-sessions-memory.md)
- [F005 Agent Tools Platform](/docs/specs/rfcs/RFC-005-agent-tools-platform.md)
- [F018 AI Architect and Agent Design Automation](/docs/specs/rfcs/RFC-018-ai-architect-agent-design-automation.md)
- [F013 Import Export and Project IO](/docs/specs/rfcs/RFC-013-import-export-project-io.md)
- [F012 Workflow HITL Triggers and Approvals](/docs/specs/rfcs/RFC-012-workflow-hitl-triggers-approvals.md)
- [F011 Workflow Actions Engine](/docs/specs/rfcs/RFC-011-workflow-actions-engine.md)
- [F006 Connectors Platform](/docs/specs/rfcs/RFC-006-connectors-platform.md)
- [F008 Knowledgebase Invocation Runtime](/docs/specs/rfcs/RFC-008-knowledgebase-invocation-runtime.md)
- [F007 Search AI Ingestion and KB Build](/docs/specs/rfcs/RFC-007-search-ai-ingestion-kb-build.md)
- [F024 Crawler Intelligence and Browser Automation](/docs/specs/rfcs/RFC-024-crawler-intelligence-browser-automation.md)
- [F014 Agent Transfer and A2A](/docs/specs/rfcs/RFC-014-agent-transfer-a2a.md)
- [F015 Agent Observability](/docs/specs/rfcs/RFC-015-agent-observability.md)
- [F016 System Observability and Reliability](/docs/specs/rfcs/RFC-016-system-observability-reliability.md)
- [F017 Developer Tooling MCP LSP CLI](/docs/specs/rfcs/RFC-017-developer-tooling-mcp-lsp-cli.md)
- [F004 ABL Language and Compiler](/docs/specs/rfcs/RFC-004-abl-language-compiler.md)
- [F002 Runtime Core Orchestration](/docs/specs/rfcs/RFC-002-runtime-core-orchestration.md)
- [F019 Admin and Governance Surfaces](/docs/specs/rfcs/RFC-019-admin-governance-surfaces.md)
- [F001 Studio Core Control Plane](/docs/specs/rfcs/RFC-001-studio-core-control-plane.md)
- [F020 Data Platform and Persistence](/docs/specs/rfcs/RFC-020-data-platform-persistence.md)
- [F021 Sandboxed Code Execution](/docs/specs/rfcs/RFC-021-sandboxed-code-execution.md)
- [F022 Platform Foundations and Shared Config](/docs/specs/rfcs/RFC-022-platform-foundations-shared-config.md)
- [F023 Infrastructure Delivery and Operations](/docs/specs/rfcs/RFC-023-infrastructure-delivery-operations.md)
- [F025 Expert Business Specification Agent](/docs/rfcs/RFC-025-expert-business-specification-agent.md)

## Coverage Artifacts

- [Feature map config](/docs/specs/feature-map.json)
- [Feature inventory](/docs/specs/FEATURE_INVENTORY.md)
- [Code coverage summary](/docs/specs/CODE_COVERAGE_SUMMARY.md)
- [Code coverage matrix (CSV)](/docs/specs/CODE_COVERAGE_MATRIX.csv)
- Generator script: `docs/specs/scripts/generate-coverage-artifacts.mjs`

## Regeneration

```bash
node docs/specs/scripts/generate-coverage-artifacts.mjs
```

The generator fails if any scoped file is not mapped to a feature.
