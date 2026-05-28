# SDLC Log: Agent Anatomy — Feature Spec (Phase 1)

**Date**: 2026-03-22
**Phase**: Feature Spec
**Artifact**: `docs/features/agent-anatomy.md`

## Decision Log

| Question                                        | Classification | Resolution                                                                                                                                                              |
| ----------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What agent types exist?                         | ANSWERED       | `metadata.type` is `'agent'` or `'supervisor'` — execution style inferred from IR content (flow, routing, hints). Source: `schema.ts:293`                               |
| Where is the compilation pipeline?              | ANSWERED       | `compileABLtoIR` in `compiler.ts:165` — stages: parse, separate profiles, compile, attach, validate, graph, hash, package                                               |
| What data models store agent anatomy?           | ANSWERED       | `project_agents`, `agent_versions`, `agent_model_configs` — all in `packages/database/src/models/`. Source: model files read directly                                   |
| Does `agent_versions` have `tenantId`?          | ANSWERED       | No. Tenant isolation depends on parent `project_agents` lookup chain. Source: `agent-version.model.ts` (no tenantId field)                                              |
| What validation runs on compiled IR?            | ANSWERED       | `validateIR` orchestrates: flow graph, tool refs, tool descriptions, cross-agent refs, field refs, reserved vars, guardrails, preflight. Source: `validate-ir.ts:26-37` |
| What routes expose agent anatomy?               | ANSWERED       | `project-agents.ts`, `agents.ts`, `agent-model-config.ts`, `versions.ts`, `workflow-versions.ts`. Source: route files read directly                                     |
| What compilation timeout is enforced?           | ANSWERED       | 30s default via `compilationTimeoutMs` option, E727 error on timeout. Source: `compiler.ts:176-211`                                                                     |
| What system tools are injected by the compiler? | ANSWERED       | `__handoff__`, `__delegate__`, `__complete__`, `__escalate__`, `__fan_out__`, `__set_context__`. Source: `compiler.ts:91-98`                                            |
| Does `agents.ts` use structured logger?         | ANSWERED       | No — uses `console.error`. Source: `agents.ts:91`. This violates code standards (GAP-008).                                                                              |
| What tool types does the IR support?            | ANSWERED       | `http`, `mcp`, `sandbox`, `lambda`, `connector`, `workflow`, `searchai`, `async_webhook`. Source: `schema.ts:572-580`                                                   |

## Files Created/Modified

- `docs/features/agent-anatomy.md` — Re-generated feature spec with full code-grounding
- `docs/sdlc-logs/agent-anatomy/feature-spec.log.md` — This log

## Review Findings

### Round 1 — Completeness & Quality

- [x] All 18+ TEMPLATE.md sections addressed (20 sections filled)
- [x] 6 user stories (minimum 3)
- [x] 10 functional requirements (minimum 4, all testable)
- [x] Integration matrix references 5 related features
- [x] Non-functional concerns address tenant, project, and user isolation
- [x] Delivery plan has parent tasks with numbered subtasks
- [x] Open questions section has 5 items
- [x] Claims grounded in code evidence (file paths, line numbers, interface names)

### Round 2 — Cross-Phase Consistency

- [x] FR numbering is consistent (FR-1 through FR-10)
- [x] Scope boundaries match non-goals
- [x] User stories align with functional requirements
- [x] Implementation files verified at stated paths
- [x] New gap discovered: GAP-008 (console.error in agents.ts)

## Key Learnings

- The AgentIR schema is ~2090 lines with 20+ top-level sections — it is the single most comprehensive type in the platform
- Agent "type" is not an enum of reasoning/flow/supervisor/etc.; it is inferred from IR content presence (flow section, routing config, runtime hints)
- `agent_versions` lacks `tenantId` — this is a deliberate design choice but creates isolation complexity
- Compilation pipeline has 11 stages, not the 9 previously documented
- Tool staleness detection (W721 warnings) is a compiler feature that compares DSL declarations against resolved project tools
