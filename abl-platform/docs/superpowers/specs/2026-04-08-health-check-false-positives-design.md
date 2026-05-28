# Design: Fix Health Check False Positives

**Date**: 2026-04-08
**Status**: Approved
**Problem**: Health check reports "Critical" with 6 errors on valid Arch-created projects, causing the LLM to loop trying to fix unfixable issues.

---

## Root Cause

The health check in `apps/studio/src/lib/arch-ai/tools/health-check.ts` has 5 bugs that produce false positives:

| #   | Bug                   | Health Check Does                                          | DSL Reality                                            |
| --- | --------------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| 1   | Handoff keyword       | Regex matches `HANDOFFS:` (plural)                         | DSL keyword is `HANDOFF:` (singular)                   |
| 2   | Handoff target format | Expects `- AgentName` flat list                            | DSL uses `- TO: AgentName` nested format               |
| 3   | Tool name format      | Expects `- toolname` flat list                             | DSL uses `name(params) -> return_type` function syntax |
| 4   | Entry point           | Requires `project.entryAgentName` set                      | Arch AI project creation never sets this field         |
| 5   | Tool binding scope    | Checks inline DSL tools against `project_tools` collection | Inline tools are self-contained, not external bindings |

## Approach: Use the Real Parser

Replace regex-based DSL extraction with calls to `parseAgentBasedABL()` from `@abl/core`. This ensures the health check always matches the parser's understanding of the DSL.

## Changes

### 1. `apps/studio/src/lib/arch-ai/tools/health-check.ts`

**`checkCompilation()`** — Refactor to return the parsed document alongside the status. Currently parses the DSL but discards the result. Instead, return it so `checkSingleAgent` can pass it to handoff/tool extractors without parsing twice.

**`extractHandoffTargets(dsl)`** — Replace regex with parser:

- Call `parseAgentBasedABL(dsl)`
- Return `doc.handoff.map(h => h.to)`
- Handles all handoff syntax variations the parser supports

**`extractToolNames(dsl)`** — Replace regex with parser:

- Call `parseAgentBasedABL(dsl)`
- Return `doc.tools.map(t => t.name)`
- Handles function-signature syntax, imports, all tool formats

**`checkToolBindings()`** — Distinguish inline vs external tools:

- Inline DSL tools (declared in the agent's TOOLS: section) are always considered bound
- Only flag tools that reference external bindings (e.g., via `FROM: ... USE:`) without matching project tools
- For MVP: if agent has tools in DSL but no project tools exist, status is PASS (not FAIL)

**`checkSingleAgent()`** — Parse once, reuse:

- Call `checkCompilation()` first to get parsed doc
- Pass parsed doc to handoff and tool checkers instead of raw DSL string

### 2. `apps/studio/src/app/api/arch-ai/message/route.ts`

In the `msg.type === 'create'` handler (~line 2594), after `Project.create()`:

- Identify the SUPERVISOR agent from `agentFiles` keys by checking which agent's DSL content starts with `SUPERVISOR:`
- Update the project: `Project.updateOne({_id: project._id}, {$set: {entryAgentName: supervisorName}})`

### 3. Files Changed

| File                                                | Change                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/studio/src/lib/arch-ai/tools/health-check.ts` | Replace regex extractors, parse-once refactor, fix tool binding logic |
| `apps/studio/src/app/api/arch-ai/message/route.ts`  | Set `entryAgentName` during project creation                          |

No new files. No new dependencies.

## Verification

1. Rebuild `@abl/compiler` (already done — Fallback_Handler fix)
2. Rebuild `@agent-platform/database` if needed
3. Restart Studio
4. Run health check on Fitness Coach Bot 05 via Arch AI in-project overlay
5. Expected: no Critical errors from handoff/tool/entry point checks
6. Re-run the 100 use case test harness to verify no regressions
