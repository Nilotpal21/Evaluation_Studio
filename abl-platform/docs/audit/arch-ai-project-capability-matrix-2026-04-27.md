# Arch AI Project Capability Matrix

Date: 2026-04-27

Companion audit: `docs/audit/arch-ai-project-capabilities-audit-2026-04-27.md`

## Status Legend

| Status             | Meaning                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Live               | Declared, registered in live ToolRegistry, and has an executor.                            |
| Partial            | Mostly live, but schema, UI, refresh, or context propagation is incomplete.                |
| Shadow-only        | Declared and/or implemented, but not available to the live model path.                     |
| Broken contract    | Live name exists, but the registered schema/executor conflicts with the declared behavior. |
| API-only           | Not a model tool; reachable through REST or internal API only.                             |
| Needs verification | Source wiring exists, but no end-to-end verification was found in this audit.              |

## In-Project Tool Matrix

| Tool                   | Feature area                 | Specialist map | Direct executor | Live registry | Current status     | Evidence                                                                            |
| ---------------------- | ---------------------------- | -------------- | --------------- | ------------- | ------------------ | ----------------------------------------------------------------------------------- |
| `compile_abl`          | Agent build/validation       | Yes            | Yes             | Yes           | Live               | `tools.ts`, `in-project-tools.ts:560`, `engine-factory.ts:1116`                     |
| `read_agent`           | Agent inspection             | Yes            | Yes             | Yes           | Live               | `in-project-tools.ts:602`, `engine-factory.ts:1498`                                 |
| `trace_diagnosis`      | Trace diagnostics            | Yes            | Yes             | Yes           | Live               | `in-project-tools.ts:653`, `engine-factory.ts:1564`                                 |
| `query_traces`         | Trace diagnostics            | Yes            | Yes             | Yes           | Live               | `in-project-tools.ts:677`, `engine-factory.ts:1691`                                 |
| `health_check`         | Project health               | Yes            | Yes             | Yes           | Live               | `in-project-tools.ts:712`, `engine-factory.ts:1730`                                 |
| `validate_agent`       | Agent validation             | Yes            | Yes             | Yes           | Live               | `in-project-tools.ts:748`, `engine-factory.ts:1584`                                 |
| `diagnose_project`     | Project diagnostics          | Yes            | Yes             | Yes           | Live               | `in-project-tools.ts:783`, `engine-factory.ts:1604`                                 |
| `explain_diagnostic`   | Diagnostic explanation       | Yes            | Yes             | Yes           | Live               | `in-project-tools.ts:817`, `engine-factory.ts:1620`                                 |
| `read_insights`        | Analytics/insights           | Yes            | Yes             | Yes           | Live               | `in-project-tools.ts:849`, `engine-factory.ts:1548`                                 |
| `run_test`             | Testing/evals                | Yes            | Yes             | Yes           | Needs verification | `in-project-tools.ts:888`, `engine-factory.ts:1711`                                 |
| `recommend_model`      | Model recommendation         | Yes            | Yes             | Yes           | Partial            | `in-project-tools.ts:911`, `engine-factory.ts:1659`                                 |
| `configure_model`      | Model configuration          | Yes            | Yes             | Yes           | Broken contract    | Direct schema is broad; live schema only accepts `agentName` and `modelId`.         |
| `analyze_constraints`  | Constraints/compliance       | Yes            | Yes             | Yes           | Live               | `in-project-tools.ts:1011`, `engine-factory.ts:1675`                                |
| `propose_modification` | Agent update proposal        | Yes            | Yes             | Yes           | Partial            | Update proposal works, but applied update refresh signal is missing.                |
| `apply_modification`   | Agent update apply           | Yes            | Yes             | Yes           | Partial            | Applies mutation; Studio views may stay stale after apply.                          |
| `dismiss_proposal`     | Proposal lifecycle           | Yes            | Yes             | Yes           | Live               | `in-project-tools.ts:1423`, `engine-factory.ts:1483`                                |
| `read_journal`         | Project journal              | Yes            | Yes             | Yes           | Live               | `in-project-tools.ts:1435`, `engine-factory.ts:1514`                                |
| `read_topology`        | Topology inspection          | Yes            | Yes             | Yes           | Live               | `in-project-tools.ts:1485`, `engine-factory.ts:1534`                                |
| `tools_ops`            | Tool lifecycle               | Yes            | Yes             | Yes           | Needs verification | `in-project-tools.ts:1559`, `engine-factory.ts:1776`                                |
| `project_config`       | Project configuration        | Yes            | Yes             | No            | Shadow-only        | Declared and implemented, absent from live registry.                                |
| `auth_ops`             | Auth profile lifecycle       | Yes            | Yes             | Yes           | Broken contract    | Executor is live; secret collection handoff schema is inconsistent.                 |
| `variable_ops`         | Variables/config             | Yes            | Yes             | Yes           | Needs verification | `in-project-tools.ts:1656`, `engine-factory.ts:1806`                                |
| `integration_ops`      | Integration draft lifecycle  | Yes            | Yes             | Yes           | Needs verification | `in-project-tools.ts:1694`, `engine-factory.ts:1850`                                |
| `collect_secret`       | Secure credential collection | Yes            | Client-side     | Yes           | Broken contract    | Live schema differs from `SecretInput` and `auth_ops` contract.                     |
| `platform_context`     | Project/platform lookup      | Yes            | Yes             | Yes           | Broken contract    | Live executor rejects project-scoped actions.                                       |
| `kb_manage`            | KB lifecycle                 | Yes            | Yes             | No            | Shadow-only        | Declared and implemented, absent from live registry.                                |
| `kb_search`            | KB search                    | Yes            | Yes             | No            | Shadow-only        | Declared and implemented, absent from live registry.                                |
| `kb_health`            | KB health/retry/status       | Yes            | Yes             | No            | Shadow-only        | Declared and implemented, absent from live registry.                                |
| `kb_ingest`            | KB ingestion                 | Yes            | Yes             | No            | Shadow-only        | Declared and implemented, absent from live registry.                                |
| `kb_connector`         | KB connector lifecycle       | Yes            | Yes             | No            | Shadow-only        | Declared and implemented, absent from live registry.                                |
| `kb_documents`         | KB document management       | Yes            | Yes             | No            | Shadow-only        | Declared and implemented, absent from live registry.                                |
| `manage_memory`        | Project memory               | Yes            | Yes             | Yes           | Partial            | Project memory is live; global learning-memory route has separate governance issue. |

## Project Feature Coverage Matrix

| Project feature                 | Arch capability expected                                                      | Current Arch status | Gap                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------- |
| Inspect project agents          | `read_agent`, `read_topology`, `platform_context list_agents`                 | Partial             | Direct agent reads are live; `platform_context list_agents` is broken in project mode. |
| Modify existing agent           | `propose_modification`, `apply_modification`, `compile_abl`, `validate_agent` | Partial             | Core flow is live; Studio reload signal is missing after apply.                        |
| Create new agent in project     | `propose_modification(isNew=true)`, `apply_modification`                      | Partial             | Mutation path exists; project agent list invalidation needs verification.              |
| Diagnose project                | `diagnose_project`, `health_check`, `trace_diagnosis`, `query_traces`         | Live/partial        | Tool path is live; full E2E coverage was not verified.                                 |
| Explain diagnostics             | `explain_diagnostic`                                                          | Live                | Registered and implemented.                                                            |
| Read analytics/insights         | `read_insights`                                                               | Live/partial        | Registered and implemented; public workflow coverage not verified.                     |
| Run tests/evals                 | `run_test`                                                                    | Needs verification  | Registered and implemented, but test/eval UX flow needs coverage.                      |
| Configure agent model           | `configure_model`, `recommend_model`                                          | Broken contract     | Recommendation is live; configuration schema is too narrow.                            |
| Inspect platform models         | `platform_context list_models`                                                | Partial/broken      | In-project can pass auth through direct executor; onboarding drops auth token.         |
| Update project settings         | `project_config`                                                              | Shadow-only         | Executor exists but tool is not live.                                                  |
| Manage auth profiles            | `auth_ops`, `collect_secret`                                                  | Broken contract     | `auth_ops` is live; secret collection schema mismatch blocks setup.                    |
| Manage variables                | `variable_ops`                                                                | Needs verification  | Registered and implemented; workflow coverage not verified.                            |
| Manage tools                    | `tools_ops`                                                                   | Needs verification  | Registered and implemented; workflow coverage not verified.                            |
| Manage integration draft        | `integration_ops`                                                             | Needs verification  | Registered and implemented; workflow coverage not verified.                            |
| Create/list/update/delete KB    | `kb_manage`                                                                   | Shadow-only         | Executor exists but tool is not live.                                                  |
| Ingest KB content               | `kb_ingest`                                                                   | Shadow-only         | Executor exists but tool is not live.                                                  |
| Search KB                       | `kb_search`                                                                   | Shadow-only         | Executor exists but tool is not live.                                                  |
| Check KB health                 | `kb_health`                                                                   | Shadow-only         | Executor exists but tool is not live.                                                  |
| Manage KB connectors            | `kb_connector`                                                                | Shadow-only         | Executor exists but tool is not live.                                                  |
| Manage KB documents             | `kb_documents`                                                                | Shadow-only         | Executor exists but tool is not live.                                                  |
| Remember project preferences    | `manage_memory`                                                               | Partial             | Tool is live; memory governance should be separated from global learning memory.       |
| Edit spec project metadata      | Spec-document API route                                                       | Partial             | `business.projectName` can false-conflict and does not update `Project`.               |
| Global Arch learning management | Learning-memory API route                                                     | Governance gap      | Tenant users can patch/delete global memories.                                         |

## Specialist Exposure Matrix

| Specialist                  | Intended capability group                             | Current risk                                                                       |
| --------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `diagnostician`             | Diagnostics, project config, model config, KB context | Sees declared `project_config` and `kb_*` ownership, but those tools are not live. |
| `abl-construct-expert`      | Agent construction, project config, tools, KB context | Agent tools mostly live; project config and KB tools are not live.                 |
| `channel-voice`             | Channel-adjacent agent work and platform context      | `platform_context` project lookups fail in live registry.                          |
| `entity-collection`         | Gather/entity flows and platform context              | `platform_context` project lookups fail in live registry.                          |
| `analyst`                   | Insights, traces, platform context                    | Trace/insight tools are live; `platform_context` project lookups fail.             |
| `observer`                  | Read-only diagnostics/validation/topology             | Mostly live; `platform_context` project lookups fail.                              |
| `multi-agent-architect`     | Topology and project config                           | `project_config` not live.                                                         |
| `testing-eval`              | Test execution and context                            | `run_test` registered; end-to-end verification still needed.                       |
| `integration-methodologist` | Tools, variables, auth, integrations                  | Core tools registered; `collect_secret` schema mismatch blocks auth profile setup. |

## Live Registry Gap Summary

Tools declared and directly implemented, but absent from the live registry:

- `project_config`
- `kb_manage`
- `kb_search`
- `kb_health`
- `kb_ingest`
- `kb_connector`
- `kb_documents`

Tools present in the live registry with mismatched behavior:

- `platform_context`
- `collect_secret`
- `configure_model`

Tools present in the live registry but needing workflow verification:

- `tools_ops`
- `variable_ops`
- `integration_ops`
- `run_test`
- `manage_memory`

## Suggested Status Targets After Fixes

| Capability group      | Target status after Phase 1 | Target status after Phase 2 | Target status after Phase 3 |
| --------------------- | --------------------------- | --------------------------- | --------------------------- |
| Agent updates         | Partial                     | Partial                     | Live                        |
| Project config        | Live                        | Live                        | Live                        |
| Platform context      | Live                        | Live                        | Live                        |
| Auth setup            | Partial                     | Live                        | Live                        |
| Model configuration   | Partial                     | Live                        | Live                        |
| Knowledge bases       | Live                        | Live                        | Live                        |
| Memories/governance   | Partial                     | Partial                     | Live                        |
| Spec/project metadata | Partial                     | Partial                     | Live or documented partial  |
