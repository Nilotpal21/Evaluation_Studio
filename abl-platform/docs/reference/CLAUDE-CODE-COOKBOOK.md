# Claude Code Cookbook: Building 85K Lines of TypeScript in 4 Days

> A methodology guide for using Claude Code to build production-grade systems at extreme velocity — covering interaction patterns, iteration speed, boundary-pushing, review discipline, and testing throughput.

---

## The Numbers

| Metric                    | Value               |
| ------------------------- | ------------------- |
| Calendar days             | 4 (Feb 3-6, 2026)   |
| Claude Code sessions      | 35                  |
| Commits                   | 65                  |
| TypeScript lines produced | 81,089              |
| Test lines                | 9,864               |
| Files touched             | 435                 |
| Lines inserted            | 136,536             |
| Commit acceleration       | 5 → 12 → 48 per day |

This wasn't a weekend hack. It produced a parser, compiler, runtime, observatory UI, MCP debug server, CLI, import pipeline, architect tools, and 613 passing tests across 8 packages and 3 apps.

This cookbook documents _how_ — the interaction methodology that made it possible.

---

## Chapter 1: The Mindset — Don't Self-Limit

### 1.1 The biggest mistake: thinking small

The natural instinct is to ask Claude Code for small things. "Fix this function." "Add a test." "Rename this variable." That works, but it's using a rocket engine to heat soup.

The breakthrough was giving Claude Code _architectural_ tasks:

```
Bad:  "Add a PRIORITY field to the HandoffConfig type"
Good: "Implement this 5-phase plan covering 4 ABL language enhancements
       and 6 extraction functions across 6 files, with type changes,
       parser updates, generator updates, and converter rewiring"
```

The second prompt produced the same work as 30+ individual prompts — but faster, because Claude Code could see the full picture and make consistent decisions across all files.

### 1.2 Plans as force multipliers

Plan mode wasn't just for getting approval. It was the single most important productivity pattern:

1. **Describe the end state** — not the steps, the _outcome_
2. **Let Claude Code explore** — it reads files, understands patterns, finds edge cases you forgot
3. **Review the plan** — this is where you catch architectural mistakes _before_ 500 lines get written
4. **Execute the plan** — Claude Code has context, types are consistent, nothing is forgotten

One plan produced the entire ABL language enhancement (4 new parser features + 8 extraction functions + generator updates + converter rewiring) in a single execution pass. Every type was consistent, every import was correct, tests passed on first build.

### 1.3 The "just do it" threshold

Not everything needs a plan. The rule was:

- **< 3 files**: Just do it
- **3-6 files with dependencies**: Plan mode
- **> 6 files or architectural change**: Plan mode with exploration phase

The key insight: _planning takes 2 minutes, rewriting takes 20_. The cost of over-planning is trivial compared to the cost of inconsistent changes across a codebase.

---

## Chapter 2: Session Architecture — Structuring Your Work

### 2.1 The session-per-concern pattern

35 sessions in 4 days wasn't chaos — it was intentional compartmentalization:

- **Session 1-5**: Core language design (types, parser)
- **Session 6-10**: Runtime execution engine
- **Session 11-15**: Observatory UI and debugging
- **Session 16-20**: MCP integration, CLI tooling
- **Session 21-25**: Import pipeline, architect tools
- **Session 26-30**: Testing, documentation, polish
- **Session 31-35**: Enterprise features, naming, refinement

Each session had a clear scope. When a session's context got heavy, I started a new one. Claude Code's auto-memory carried forward the patterns and lessons. This meant:

- Fresh context for each concern (no confused state)
- Memory accumulated real patterns (not stale assumptions)
- Parallel work streams were possible (UI in one session, runtime in another)

### 2.2 The warm-up pattern

Every new session started the same way:

1. Claude Code reads auto-memory (automatic)
2. I give a brief orientation: "We're working on the import pipeline. The converter is at `packages/kore-platform-cli/src/mcp/import/`"
3. Claude Code explores the relevant files
4. We're productive within 60 seconds

The auto-memory file (`MEMORY.md`) was the key. It accumulated:

- Project structure (so Claude Code never asked "where is X?")
- Type patterns (so imports were always correct)
- Common issues and fixes (so known bugs weren't repeated)
- API patterns (so new code matched existing conventions)

### 2.3 When to start a new session

- **Context is getting heavy** — responses slow down, Claude Code loses track of earlier decisions
- **Switching domains** — from runtime to UI, from parser to CLI
- **Major milestone complete** — commit, then fresh session for next phase
- **Something feels wrong** — if Claude Code is going in circles, fresh context often unsticks it

---

## Chapter 3: Iteration Speed — The Commit-Test-Iterate Loop

### 3.1 The acceleration curve

```
Day 1 (Feb 3):   5 commits  — Foundation: types, parser, first tests
Day 2 (Feb 4):  12 commits  — Runtime: actions, FLOW, Observatory
Day 3 (Feb 5):  48 commits  — Everything else: MCP, CLI, import, docs, security
```

Day 3 wasn't 4x harder than Day 2. It was 4x _faster_ because:

1. **Patterns were established** — Claude Code knew the conventions
2. **Types were solid** — new features built on reliable foundations
3. **Tests caught regressions** — changes were safe to make quickly
4. **Auto-memory accumulated** — less orientation needed per session

### 3.2 The tight loop

The core iteration cycle was:

```
1. Describe what I want (30 seconds)
2. Claude Code implements (2-5 minutes)
3. Build check: pnpm build (20 seconds)
4. Test check: pnpm test (30 seconds)
5. Review the diff (1-2 minutes)
6. Commit or course-correct
```

Total cycle time: **5-8 minutes per feature**. This meant I could ship 8-12 features per hour.

The critical insight: **never skip steps 3-5**. The 2 minutes spent reviewing saves 20 minutes debugging later. Claude Code is fast but not infallible — reviewing the diff is how you maintain quality at speed.

### 3.3 Parallel execution with sub-agents

Claude Code's Task tool was a game-changer for parallelism:

```
"Read these 6 files in parallel, then implement based on what you find"
```

Instead of sequential file reading → planning → implementing, Claude Code could:

- Launch 3 explore agents simultaneously to understand different parts of the codebase
- Run builds and tests in the background while implementing the next feature
- Gather research data from multiple sources at once

This is why Day 3 had 48 commits — the overhead per feature dropped as parallelism increased.

---

## Chapter 4: Pushing Boundaries — Ambitious Prompts

### 4.1 The "full system" prompt

The most productive prompts described entire systems:

```
"Build an MCP debug server that:
- Connects via WebSocket to the runtime
- Exposes 15 debug tools (traces, state, errors, analysis)
- Has embedded documentation queryable by topic
- Supports session subscription for live debugging
- Works with Claude Code's MCP protocol"
```

Claude Code built the entire thing — server, tools, docs, types, tests — in one session. The alternative (asking for each piece individually) would have taken 5x longer and produced less consistent code.

### 4.2 The "import pipeline" prompt

```
"Build an import system that:
- Detects whether a JSON file is Agent Platform v12 or XO11 format
- Analyzes the export to find agents, tools, routing, memory
- Converts to ABL architecture spec with gap detection
- Scaffolds a complete ABL project from the spec
- Handles all edge cases: empty tools, missing prompts, circular routing"
```

This produced 4 files, ~1,500 lines, covering analysis, conversion, scaffolding, and gap reporting. One prompt. One pass.

### 4.3 The "language enhancement" prompt

The most ambitious: implementing 4 new language features + 8 extraction functions + generator updates + converter rewiring, all described in a single plan. It touched 6 core files across 2 packages and required type consistency across all of them.

Result: everything built, tested, and working on the first try. This was possible because the plan was detailed enough for Claude Code to see all dependencies before writing any code.

### 4.4 When ambitious fails

Not every ambitious prompt worked. The failure mode was always the same: **underspecified requirements**. When I said "make the UI better" without specifics, Claude Code made reasonable but wrong choices. When I said "add authentication" without specifying the flow, it picked OAuth when I wanted device authorization.

The fix: be ambitious about _scope_, specific about _requirements_. "Build the entire auth system" is fine as long as you specify JWT + refresh tokens + device authorization flow + Prisma storage.

---

## Chapter 5: Review Discipline — Trust But Verify

### 5.1 The three-level review

Every Claude Code output got reviewed at one of three levels:

**Level 1: Glance** (10 seconds) — For small, well-understood changes

- Does the diff look reasonable?
- Are there any obvious red flags?
- Did tests pass?

**Level 2: Read** (1-2 minutes) — For new features

- Do the types make sense?
- Are imports correct?
- Does the logic handle edge cases?
- Are there security concerns?

**Level 3: Trace** (5-10 minutes) — For architectural changes

- Follow the data flow end to end
- Check that all callers are updated
- Verify type consistency across package boundaries
- Run the feature manually

### 5.2 What to watch for

Patterns where Claude Code needed correction:

1. **Over-engineering** — Adding abstractions for things that only happen once. "You don't need a factory pattern for this, just call the function."

2. **Stale assumptions** — Using a pattern from an earlier session that was since refactored. Auto-memory usually caught this, but not always.

3. **Missing edge cases** — The happy path was always correct. Edge cases (empty arrays, null values, malformed input) sometimes needed prompting.

4. **Import paths** — In a monorepo with `.js` extensions in imports, Claude Code occasionally used wrong relative paths. The TypeScript build caught these instantly.

5. **Security shortcuts** — When moving fast, it's easy to skip input validation or use `any` types. I caught and fixed these during review.

### 5.3 The "rebuild test" ritual

Before every commit:

```bash
pnpm build    # Type-checks everything
pnpm test     # Runs all 613 tests
```

This was non-negotiable. It took 50 seconds total. In that 50 seconds, it caught:

- Type mismatches across package boundaries
- Broken imports from refactoring
- Regressions in parser behavior
- Missing exports

The 50-second investment prevented hours of debugging. Every. Single. Time.

---

## Chapter 6: Testing Throughput — 613 Tests in 4 Days

### 6.1 Tests as a speed multiplier

Counter-intuitive: writing tests _increases_ velocity. Here's why:

- **Confidence to refactor** — When I renamed DSL to ABL across the entire codebase (Day 3), 613 tests confirmed nothing broke. Without tests, that rename would have taken a full day of manual checking.

- **Fast feedback on changes** — A failing test tells you exactly what broke and where. Console debugging tells you nothing for 10 minutes.

- **Claude Code writes tests well** — "Add comprehensive tests for the parser's new PRIORITY field" produces excellent test coverage. Tests are one of Claude Code's strongest capabilities.

### 6.2 The test-first pattern for risky changes

For changes that could break things (parser modifications, type changes), the pattern was:

```
1. Write tests for the new behavior first
2. Watch them fail (confirms the test is testing the right thing)
3. Implement the feature
4. Watch them pass
5. Run full suite to check for regressions
```

Claude Code executed this pattern naturally when prompted: "Add tests for HANDOFF PRIORITY parsing, then implement the parser change."

### 6.3 Test distribution

```
Core parser/types:     67 tests
Compiler:             279 tests
Runtime:              156 tests
CLI/MCP tools:        111 tests
─────────────────────────────
Total:                613 tests
```

The heaviest testing was on the compiler (279 tests) — the most complex transformation layer. This was intentional: the compiler converts AST to IR, and any bug there corrupts everything downstream.

### 6.4 What not to test

Claude Code sometimes generated tests for trivial things (getter functions, simple string formatting). The review step caught these: "We don't need a test for `toFilename()`, it's a one-liner with no branching."

Rule: test _behavior_, not _implementation_. Test "parsing a HANDOFF with PRIORITY produces the right config" not "the regex matches the string PRIORITY".

---

## Chapter 7: The Compounding Effect

### 7.1 Why Day 3 was 4x faster than Day 1

It wasn't because I typed faster. It was compounding returns from:

1. **Types compound** — Every new type added to `agent-based.ts` made the next feature easier. The parser knew what to produce. The compiler knew what to consume. The runtime knew what to execute.

2. **Tests compound** — Each test written protected all future changes. By Day 3, I could refactor fearlessly because 400+ tests had my back.

3. **Memory compounds** — Claude Code's auto-memory accumulated patterns. By Day 3, it never asked "what's the import path for AgentState?" — it knew.

4. **Patterns compound** — The first TOOL parser took exploration. The second (GATHER) followed the same pattern. By the fifth (GUARDRAILS), Claude Code could implement it without guidance.

5. **Infrastructure compounds** — The build/test pipeline, MCP integration, debug tools — all reduced friction for every subsequent feature.

### 7.2 The velocity chart tells the story

```
Day 1:  ████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  5 commits
Day 2:  ██████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  12 commits
Day 3:  ████████████████████████████████████████████  48 commits
```

This isn't linear growth. It's compounding infrastructure paying dividends.

### 7.3 How to build the compound

The first day felt slow. Five commits. But those 5 commits were:

- Core type definitions (the foundation everything builds on)
- Parser skeleton (the pattern every section parser follows)
- First passing tests (the safety net for everything after)
- Visual test UI (the feedback loop for runtime development)
- WebSocket infrastructure (the plumbing for Observatory)

Every one of those was a _platform_ for future velocity, not a _feature_.

---

## Chapter 8: Prompt Engineering for Code Generation

### 8.1 The anatomy of a productive prompt

The best prompts followed this structure:

```
[Context]: What exists, what we're building on
[Requirement]: What the outcome should be
[Constraints]: What patterns to follow, what to avoid
[Verification]: How to know it's correct
```

Example:

```
"The ABL parser in packages/core/src/parser/agent-based-parser.ts
currently parses HANDOFF sections. [Context]

Add parsing for a PRIORITY field in HANDOFF rules — it should be
an optional integer that controls evaluation order. [Requirement]

Follow the existing parseHandoffConfig() pattern. Add the field
to HandoffConfig in agent-based.ts. [Constraints]

Add tests that parse 'PRIORITY: 0' and verify config.priority === 0,
and that missing PRIORITY leaves it undefined. [Verification]"
```

### 8.2 Context is everything

Claude Code can read files, but telling it _which_ files to read saves a round trip:

```
Less efficient: "Add a new field to the agent types"
More efficient: "Add a 'language' field to AgentBasedDocument in
                 packages/core/src/types/agent-based.ts, then update
                 the parser at packages/core/src/parser/agent-based-parser.ts
                 to parse 'LANGUAGE:' sections"
```

The second prompt gives Claude Code a clear execution path instead of making it search.

### 8.3 Reference patterns, not just requirements

```
"Implement parseGuardrailsFromPrompt() following the same pattern
as parseConstraintsFromPrompt() — scan lines for keywords, build
structured specs, return an array"
```

Claude Code matches existing patterns extremely well. Point it at a reference implementation and it produces consistent code.

### 8.4 When to be vague

Sometimes vague is better:

```
"The import converter is putting everything in LIMITATIONS. Make it smarter —
extract structured CONSTRAINTS, GUARDRAILS, FLOW, and MEMORY from the prompt
text, and only fall back to LIMITATIONS for genuinely unstructured content."
```

This prompt described the _problem_ and the _goal_ without prescribing the solution. Claude Code's solution (8 extraction functions with regex-based heuristic parsing) was more thorough than what I would have specified.

---

## Chapter 9: Error Recovery — When Things Go Wrong

### 9.1 Build failures

The most common issue: type mismatches after changes span multiple packages.

**Recovery pattern:**

```
"The build failed with [error]. Fix it — the types need to be
consistent between packages/core and packages/kore-platform-cli."
```

Claude Code reads the error, traces the type mismatch, and fixes both sides. Usually a one-round-trip fix.

### 9.2 Test failures after refactoring

When a rename or restructuring broke tests:

```
"pnpm test failed — update the tests to match the new structure.
Don't change the tested behavior, just fix imports and paths."
```

Key instruction: "Don't change the tested behavior." Without this, Claude Code might "fix" tests by weakening assertions.

### 9.3 The "start fresh" escape hatch

Twice in 35 sessions, I hit a dead end where Claude Code was going in circles. The fix:

1. Commit what works
2. Start a new session
3. Describe the goal fresh
4. Let Claude Code approach it without the baggage of failed attempts

Fresh context is underrated. A new session doesn't have the weight of 50 back-and-forth messages. It approaches the problem clean.

### 9.4 Never brute-force

If something fails twice, stop and think. Claude Code's instinct is to retry with small variations. Your job is to step back and ask: "Is this the right approach, or are we solving the wrong problem?"

---

## Chapter 10: The Meta-Pattern — Building Tools That Help You Build

### 10.1 The Observatory feedback loop

Day 2, I built the Agent Observatory — a visual debugger for watching agents execute in real-time. This wasn't a feature for end users. It was a tool for _me_ to debug the runtime faster.

With the Observatory, I could:

- Watch state transitions as they happened
- See exactly which LLM calls were made and why
- Identify where constraint checks failed
- Trace handoff routing decisions

This investment (one session, ~3 hours) paid for itself within 24 hours. Every runtime bug after that was diagnosed in the UI instead of console logs.

### 10.2 The MCP debug server

Day 3, I built MCP debug tools so Claude Code could debug its own agents. This created a recursive loop:

```
Claude Code builds agent → Agent has a bug →
Claude Code uses debug tools to diagnose →
Claude Code fixes the bug → Better agent
```

The debug server had 15 tools: trace inspection, state viewing, error analysis, session subscription, documentation lookup. This meant I could say "the agent is looping at step 3, debug it" and Claude Code would use its own tools to investigate.

### 10.3 The architect tools

Day 4, I built architect tools — MCP tools for generating new ABL projects from a description. Now Claude Code could:

```
1. Listen to a description of an agent system
2. Design the architecture (supervisor vs network, agent count, tools)
3. Generate complete ABL files
4. Scaffold the project directory
5. Validate the output
```

This is the ultimate meta-pattern: using Claude Code to build tools that make Claude Code more powerful.

---

## Chapter 11: Mistakes I Made (And How I Fixed Them)

### 11.1 Going too deep before going wide

Early sessions spent too long perfecting the parser before building the runtime. The parser was at 95% coverage, but I couldn't _run_ anything. Switching to a "walking skeleton" approach — parser → compiler → runtime → test, even if each was at 60% — was dramatically more productive.

**Lesson:** Get a working end-to-end path first. Polish later.

### 11.2 Not committing often enough

Days 1-2 had big commits (lots of changes per commit). Days 3-4 had small, focused commits. Small commits were better because:

- Easy to review
- Easy to revert if something goes wrong
- Better git history for understanding the evolution
- Forces you to think about what's actually done vs. in-progress

**Lesson:** Commit every working increment, no matter how small.

### 11.3 Underspecifying the rename

When renaming DSL to ABL, I initially said "rename DSL to ABL throughout the codebase." Claude Code did it, but missed some edge cases (comments, error messages, variable names). The fix was being specific about _what_ to rename: types, file names, exports, UI labels, documentation, CLI commands.

**Lesson:** For sweeping changes, enumerate the categories explicitly.

### 11.4 Trusting without verifying

Once, Claude Code generated a security fix that looked correct but weakened CORS protection. The review caught it, but it was a reminder: **always read the diff, especially for security-related changes**.

**Lesson:** Speed is great, but never skip review for security-sensitive code.

---

## Chapter 12: Interaction Anti-Patterns

### 12.1 The "one more thing" trap

```
"Add PRIORITY to handoffs"
"Also add WHEN to flow steps"
"Oh and add MAX_ATTEMPTS too"
"And LANGUAGE directive while you're at it"
```

Each "one more thing" makes Claude Code juggle more state. Instead, batch them into a single plan. The plan for these exact 4 features was one prompt and one execution — cleaner, faster, more consistent.

### 12.2 The "fix the test" reflex

When a test fails, the instinct is "fix the test." But sometimes the test is right and the code is wrong. Always ask: "Did the behavior change intentionally, or is this a regression?" before telling Claude Code to update tests.

### 12.3 The "explain everything" overhead

Claude Code doesn't need a lecture on how TypeScript works. It doesn't need background on what a parser is. Give it the _project-specific_ context (file paths, conventions, patterns) and trust it with the _general_ knowledge.

### 12.4 The "manual context" trap

Don't paste 200 lines of code into your prompt. Say "read the file at X" and let Claude Code do it. It processes the file better when it reads it fresh than when you paste it into a message.

---

## Chapter 13: Scaling the Methodology

### 13.1 From prototype to production

The same methodology scaled from "let's try this parser idea" (Day 1) to "build the enterprise import pipeline with gap detection" (Day 4). What changed:

- **More specific constraints** — "Follow existing patterns" replaced "figure it out"
- **Better test coverage** — New features had tests before implementation
- **Smaller iteration cycles** — Build-test-commit after every feature, not every session
- **Richer auto-memory** — Claude Code had 4 days of accumulated wisdom

### 13.2 When to slow down

The acceleration curve has a natural limit. When I hit 48 commits on Day 3, some were polish commits (documentation, formatting, minor fixes). The _feature_ velocity peaked around 15-20 significant features per day. Beyond that, quality drops.

Signs to slow down:

- Build failures increase
- Tests start needing fixes more than code
- You're skipping review to save time
- Commits are "fix previous commit" chains

### 13.3 The 80/20 of Claude Code productivity

The 20% of techniques that produce 80% of results:

1. **Plan mode for multi-file changes** — Prevents cascading inconsistencies
2. **Auto-memory** — Eliminates repeated orientation
3. **Build-test after every change** — Catches problems at the smallest possible scope
4. **Specific file paths in prompts** — Eliminates search overhead
5. **Reference patterns** — "Do it like X" produces consistent code

---

## Chapter 14: The Session Timeline

A compressed view of what 35 sessions and 65 commits actually looked like:

```
Feb 3 (Day 1) — Foundation
  13:06  Visual Test UI with runtime integration
  13:38  WebSocket connection sharing
  13:52  DSL action constructs (HANDOFF, DELEGATE, COMPLETE, ESCALATE)
  13:58  Fix escalate/complete final responses
  14:02  Supervisor routing with intent mapping

Feb 4 (Day 2) — Core Runtime
  16:24  Supervisor routing fix (RETURN field)
  18:16  FLOW mode with ON_INPUT branching
  18:42  Modular documentation
  19:01  Test updates
  20:55  Agent Observatory
  01:18  Enhanced FLOW (GATHER, digressions)
  01:45  DELEGATE, COMPLETE, CONSTRAINTS runtime
  02:56  Test fixes
  03:02  Constraint checking
  03:03  Static graph extraction

Feb 5 (Day 3) — Expansion Sprint
  13:28  LLM caching + E2E test optimization
  16:55  Enhanced tracing, Observatory redesign
  16:56  MCP debug server (15 tools)
  17:17  Bounded TraceStore
  18:37  MCP/UI bug fixes
  19:44  Digressions design
  19:46  Documentation consolidation
  19:58  STATUS.md with test coverage
  20:02  Status update
  20:04  Flow graph visualization
  20:18  Graph execution state fix
  20:29  Major codebase cleanup
  21:52  Auth, projects, DSL editor, guardrails
  22:45  Merge MCP servers + embedded docs
  22:50  Config loading + guardrails support
  22:53  Guardrails test fix
  23:18  E2E test update
  23:19  Dev-login for CLI
  23:19→ ProjectDashboard, auth requirement, chat position
  00:07→ Data/Context/Logs tabs, DSL source view

Feb 6 (Day 4) — Enterprise + Polish
  00:34  Logout fix
  00:48  App rename + cleanup
  01:02  Platform/studio rename
  07:21  MCP + guardrails test infrastructure
  07:34  Enterprise roadmap
  07:50  Roadmap with tech stack
  07:55  ABL rename (language)
  08:20  Security fixes
  08:26  GatherProgress sync
  08:37  Reference cleanup
  09:15  DSL → ABL full rename
  09:29  UI text labels
  09:46  ABLGenerator rename
  09:50  ABLGenerator tests
  09:51  Reasoning gather handoff test
  10:02  ABL references (packages)
  10:08  ABL references (apps)
  10:11  Documentation rename
  10:22  Function rename
  10:29  Delegate/handoff/validation fixes
  10:34  Architect + import MCP tools
  13:51  Architect/import/validate tests
  13:57  Guides + STATUS update
```

Notice the rhythm: features cluster, then tests, then documentation, then the next feature cluster. This wasn't accidental — it was the natural cadence of build-test-document-repeat.

---

## Chapter 15: Principles

If I had to distill this into rules:

1. **Be ambitious with scope, specific with requirements.** Claude Code handles complexity well. What it can't handle is ambiguity.

2. **Plan before you build, review after you build.** The 2 minutes spent planning save 20 minutes of rework. The 2 minutes spent reviewing prevent bugs from compounding.

3. **Build the compound early.** Types, tests, and tooling feel slow on Day 1 but make Day 3 explosive.

4. **Commit often, test always.** Small commits with passing tests create a ratchet — you can only move forward.

5. **Start fresh when stuck.** A new session costs nothing. A frustrated session costs hours.

6. **Build tools for yourself.** The Observatory, the debug server, the architect tools — each one made everything after it faster.

7. **Let Claude Code surprise you.** The 8 extraction functions it wrote for the import pipeline were more thorough than what I would have specified. Give it the problem, not just the solution.

8. **Speed comes from safety.** Paradoxically, the fastest path forward is the one with the most guardrails — types, tests, reviews, small commits. They let you move without fear.

---

_65 commits. 35 sessions. 81,089 lines. 613 tests. 4 days._

_The bottleneck was never Claude Code's capability. It was learning to ask for enough._
