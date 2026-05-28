/**
 * Layer 0: Platform Foundation — always loaded in every system prompt.
 *
 * Source: docs/superpowers/specs/2026-04-24-arch-knowledge-rework-design.md § L0
 * MDX ref: apps/docs-internal/content/abl-reference/language-overview.mdx, full-specification.mdx
 *
 * Purpose: Give Arch a complete mental model of what ABL is, what exists,
 * what doesn't, and the most critical behavioral rules. This prevents
 * hallucination of invalid constructs (MODE:, STATE:, FOR_EACH, etc.)
 * which was the #1 failure mode with the previous thin L0.
 */

export const PLATFORM_LIMITS_CARD = `## ABL Platform Foundation

### Valid ABL Sections
These are ALL the top-level sections an ABL agent file can contain:
AGENT (required), GOAL (required), PERSONA, LIMITATIONS (prompt-only — not enforcement), IDENTITY, SYSTEM_PROMPT, INSTRUCTIONS, TOOLS, GATHER, MEMORY, FLOW, HANDOFF, DELEGATE, CONSTRAINTS, GUARDRAILS, EXECUTION, ON_ERROR, ESCALATE, COMPLETE, ON_START, HOOKS, MESSAGES, NLU, ENTITIES, MULTI_INTENT, LOOKUP_TABLES, TEMPLATES, ACTION_HANDLERS, RETURN_HANDLERS, ATTACHMENTS, DESTINATIONS, BEHAVIOR_PROFILE.

### Rejected Constructs — NEVER Generate These
| Keyword | Status | Use Instead |
|---|---|---|
| MODE: | Deleted | Execution mode derived from structure (see below) |
| MODEL: (top-level) | Rejected | EXECUTION: model: |
| ROUTING: | Rejected | HANDOFF: on supervisor agents |
| STATE: (agent-level) | No parser branch | MEMORY: session: |
| POLICIES: | Legacy | CONSTRAINTS + GUARDRAILS + LIMITATIONS |
| KNOWLEDGE: | Not a section | Declare a SearchAI tool in TOOLS: |
| TESTS: | Parsed but discarded | External test files |
| FALLBACK_HANDLER: | Not a section | Name an agent \`AGENT: Fallback_Handler\` |
| INPUTS: / OUTPUTS: | Not sections | DELEGATE.INPUT/RETURNS or HANDOFF.PASS |
| FOR_EACH / WHILE / LOOP / PARALLEL / EMIT / WAIT / RETURN / BREAK / CONTINUE | Not step types | TRANSFORM for arrays, REASONING zone for iterative work, THEN back-pointer for manual loops (capped at 100) |

### Three Execution Modes (Derived, Not Declared)
- **Supervisor:** File starts with \`SUPERVISOR:\` instead of \`AGENT:\`
- **Scripted (FLOW):** Has a non-empty \`FLOW:\` section. Steps execute in order; LLM only enters inside REASONING zones or for GATHER extraction.
- **Reasoning:** No FLOW section. LLM drives the conversation turn by turn, choosing tools freely. Bounded by \`max_iterations\` (default 10).

### Runtime Coordination Contracts
- \`RETURN: true\` means the caller waits for the target agent to complete, then resumes through the return contract.
- A return target needs a reachable \`COMPLETE:\` condition or another explicit control path back to the caller. Removing \`COMPLETE:\` from a target of \`RETURN: true\` can block the parent.
- \`COMPLETE:\` is evaluated by the runtime against session state after turns and flow steps. If there are no completion conditions, the runtime has no automatic completion condition to satisfy.
- \`GATHER:\` fields are session state. They can be consumed locally or returned to a parent via \`ON_RETURN.map\`; without a map, gathered child fields default-merge back to the parent by same name.
- Health-score cleanup is not a local deletion exercise. Do not remove \`GATHER:\`, \`MEMORY:\`, \`FLOW:\`, \`HANDOFF:\`, or \`COMPLETE:\` from a return target unless full-project diagnostics stay healthy.

### Top 10 Anti-Patterns
1. Putting enforcement rules in LIMITATIONS — it is prompt text only. Use CONSTRAINTS for business rules, GUARDRAILS for safety.
2. Using FOR_EACH/WHILE as step types — use TRANSFORM for array pipelines, REASONING zone with EXIT_WHEN + MAX_TURNS for iterative LLM work.
3. Using \`human_approval\` — it parses but has no runtime executor. Use ESCALATE with a connector action.
4. CONSTRAINTS named phases (\`pre_search:\`, \`pre_booking:\`) — cosmetic only, checks run every turn. Use \`always:\` with \`BEFORE tool_call(x)\` for precision.
5. CEL namespaced access (\`input.X\`, \`state.X\`, \`memory.X\`) — does not exist. Everything is flat in session.data.values. Write \`amount > 10000\`, not \`input.amount > 10000\`.
6. CEL strict equality \`===\` — rejected in behavior profiles, silent failure elsewhere. Use \`==\`/\`!=\`.
7. Connector tool names without dot: \`slack_send_message\` fails. Must be \`slack.send_message\`.
8. Expecting .tools.abl files to resolve at runtime — they are import/export bundle format only. Tools resolve from the project tool database.
9. ELSE branch placed before IF branches in ON_INPUT/ON_RESULT — first match wins. ELSE (no-condition) must be last.
10. Using \`SYSTEM_PROMPT: |\` without re-including GOAL/PERSONA/LIMITATIONS — custom template replaces the auto-built one entirely.

### Resolution Chains (How References Become Real)
- **Tools:** Agent declares names → resolved from project tool DB at compile time → connector fallback for dotted names → E721 error if not found.
- **SearchAI:** \`index_id\` is literal → eager discovery at session start → 5-min manifest cache.
- **MCP:** Inline binding first → registry fallback → max 20 servers/project. Stdio allowlist: npx, node, python, python3, uvx, docker.
- **Connectors:** Dotted name → ConnectorRegistry → per-user connection first, then shared tenant connection.
- **Auth:** \`auth_profile_ref\` takes absolute precedence over inline auth → per-user or shared based on connection_mode.
- **Templates:** \`{{secrets.X}}\`, \`{{env.X}}\`, \`{{_context.X}}\`, \`{{session.X}}\` — regex substitution, NOT CEL. \`{{config.X}}\` resolves at compile time only.
- **Secrets:** 5-layer chain: special keys → session cache → auth profile → encrypted DB → inline credentials. No process.env fallback.

### CEL Critical Rules
- **Flat context** — everything lives in session.data.values. No namespace prefixes.
- **Reserved words skip null-injection:** size, has, type, filter, all, exists, map, list, matches, contains, startsWith, endsWith. Avoid these as field names.
- **4096-byte cap** — expressions over 4KB fail at eval with no compile-time warning.
- **Legacy fallback hides typos** — a CEL parse error silently falls back to a legacy evaluator that returns \`false\`. Your typo becomes silent \`false\`.
- **\`condition\` vs \`when\` key names** — ON_INPUT/ON_RESULT/CONSTRAINTS use \`condition\`. HANDOFF/DELEGATE/behavior_profile/escalation/remember use \`when\`. A typo is silently ignored.

### Remote agent handoffs
- **\`LOCATION: remote\`** on a HANDOFF target marks it as an externally registered A2A agent rather than an in-project ABL agent.
- **\`ENDPOINT:\` is optional in DSL** — the External Agent Registry holds the URL; setting ENDPOINT in DSL must match the registered value or compile rejects.
- **\`PROTOCOL: a2a | rest\`** — \`a2a\` (default) speaks A2A JSON-RPC + caches \`/.well-known/agent-card.json\`; \`rest\` is a thin REST adapter for partners.
- **Auth lives in the registry**, never in the agent file. \`authType\` is one of \`bearer | api_key | none\`; the executor stitches the secret onto outgoing requests at runtime.
- **\`CONTEXT.pass\` is typed** — every name must resolve to a GATHER/MEMORY field on the calling agent; the compiler validates against the resolved schema and the runtime serializes against the remote's \`inputSchema\`.`;
