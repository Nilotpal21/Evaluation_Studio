# HELIX CLAUDE

Read the repository root `CLAUDE.md` first for global rules, then `packages/helix/HELIX.md` for the full HELIX overview (architecture, components, CLI, drift-sync, contributor rules, future work). This file is the narrow Claude-agent brief — the operational rules Claude agents must honor when touching `packages/helix/`.

## Control Plane First

1. Use HELIX control-plane tools (`helix-mcp`) before rereading `.helix/sessions/*/session.json` or `progress.log`. Prefer `get_slice_packet`, `list_gate_results`, `get_dependency_dag`, `search_findings`, and `explain_blocker` over raw file reads for session meaning.
2. Use `rg` and direct file reads for code changes, not for rebuilding already-derived HELIX state.

## Implementation Bias

- If a rule is deterministic, move it into a verifier, service, checkpoint, or hook instead of repeating it in prompts.
- If the same failure signature happens again, record or strengthen harness-defect handling instead of widening retries.
- Keep slice packets shaped like good engineering issues: objective, contracts, required proof, impact watchlist, definition of done.
- Preserve checkpoint reuse and diff-hash reuse when modifying slice execution.

## Change Checklist (mandatory tests to update)

- Prompt or slice-packet changes → `src/__tests__/stage-runner.test.ts`
- Quality-gate changes → `src/__tests__/quality-gate.test.ts`
- Oracle retry or checkpoint changes → `src/__tests__/oracle-constellation.test.ts`
- Pipeline state or resume changes → `src/__tests__/pipeline-engine.test.ts`
- MCP surface changes → `src/__tests__/control-plane-service.test.ts`
- Concerns registry or audit changes → `src/__tests__/concerns-registry.test.ts`, `src/__tests__/concerns-audit.test.ts`
- Drift-audit pipeline or JIRA adapter changes → `src/__tests__/drift-audit.test.ts`, `src/__tests__/drift-jira-adapter.test.ts`
- Drift sync CLI changes → `src/__tests__/drift-sync-command.test.ts`, `src/__tests__/drift-sync-e2e.test.ts`
- OpenAI executor changes → `src/__tests__/openai-api-executor.test.ts`, `src/__tests__/model-router.test.ts`
- Dueling-plan changes → `src/__tests__/execute-dueling-plan-generation.test.ts`, `src/__tests__/dueling-plan-synthesis-prompt.test.ts`, `src/__tests__/pipeline-engine.test.ts`
- Doctor / readiness preflight changes → `src/__tests__/doctor.test.ts`

See `agents.md` for the append-only learning journal. Append a new entry after completing non-trivial work in this package.
