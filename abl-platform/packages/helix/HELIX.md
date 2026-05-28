# HELIX — Harness for Engineering Loops and Intelligent eXecution

Canonical entry-point doc for HELIX. Read this first. Deeper references:

- `agents.md` — append-only learning journal for contributors (read before modifying code)
- `CLAUDE.md` — agent-specific behavior rules (subset of this doc, narrowed for Claude agents)
- `docs/plans/helix-autonomous-harness-roadmap.lld.md` — future roadmap (Phases 0–N)
- `docs/features/helix-autonomous-engineering-harness.md` — feature spec
- `docs/design/HELIX-REPO-READINESS-CONTRACT.md` — readiness contract design

---

## What is HELIX?

**HELIX** (Harness for Engineering Loops and Intelligent eXecution) is a multi-model agentic engineering workflow engine. It coordinates AI models (Claude Opus, Claude Sonnet, OpenAI Codex/GPT-5.4) through structured, repeatable pipelines — deep codebase audits, bug fixes, multi-slice implementations — with quality gates, JIRA traceability, and human checkpoints at every stage.

It lives at `packages/helix/` in the abl-platform monorepo as both a CLI tool (`helix`) and a programmatic library (`@agent-platform/helix`). Given a work item, HELIX drives the engineering loop end-to-end: scan, analyze, plan, implement, test, review, regress, commit — producing focused, well-tested git commits tied to JIRA tickets.

HELIX is not a chatbot or assistant. It is a **pipeline executor** — a harness that loops AI agents through predefined stages, each with explicit exit criteria that must pass before the loop advances.

---

## Why Does HELIX Exist?

The abl-platform monorepo is large (60+ packages, 5 apps) and has accumulated technical debt, architectural inconsistencies, and feature gaps that are difficult to address manually at scale. Commit history analysis revealed a 2.8:1 fix-to-feat ratio — for every feature, nearly 3 fix commits followed. Root causes: mega-commits bundling concerns, missing test coverage, and implementations that didn't follow platform invariants (tenant isolation, centralized auth, structured errors).

HELIX was built to close the loop between "AI writes code" and "code is production-ready":

1. **Engineering loops, not one-shots**: A single model pass rarely produces production-quality output. HELIX runs iterative loops — scan, implement, gate-check, feed back, re-run — until exit criteria are met. The "loop" in the name is the core design principle.

2. **Intelligent execution routing**: Different models excel at different tasks. Codex/GPT-5.4 handles deep code reading and large-scale implementation. Claude Opus handles architecture review and nuanced judgment. HELIX routes each task to the right model with fallback chains and layered refinement — the "intelligent execution" part.

3. **Structured quality gates**: Instead of relying on developer discipline, quality gates (typecheck, test, lint, architecture review) are built into the pipeline. A slice cannot commit until its test lock is engaged and all exit criteria pass.

4. **Safe, reviewable commits**: Each commit is scoped to a single slice (max ~40 files, 1-3 packages), linked to a JIRA ticket, formatted with prettier, and typechecked before commit. Out-of-scope changes are excluded automatically.

5. **Traceable autonomous development**: The autonomy policy, test locks, user checkpoints, and JIRA integration create a system where AI-driven changes are traceable, reversible, and reviewable — not a black box.

---

## Contributor Rules — Read Before Changing Code

### Control Plane First

1. Use HELIX control-plane tools before rereading `.helix/sessions/*/session.json` or `progress.log`.
2. Reach for `helix-mcp` when the question is about session meaning, not file text: slice packet, gate reuse, blocker explanation, dependency DAG, findings search.
3. Use `rg` and direct file reads for code changes, not for rebuilding already-derived HELIX state.

### HELIX Implementation Bias

- If a rule is deterministic, move it into a verifier, service, checkpoint, or hook instead of repeating it in prompts.
- If the same failure signature happens again, record or strengthen harness-defect handling instead of widening retries.
- Keep slice packets shaped like good engineering issues: objective, contracts, required proof, impact watchlist, and definition of done.
- Preserve checkpoint reuse and diff-hash reuse when modifying slice execution.

### Change Checklist — Touch These Tests

| When you change                      | Run / extend                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| Prompt or slice-packet shape         | `src/__tests__/stage-runner.test.ts`                                               |
| Quality-gate logic                   | `src/__tests__/quality-gate.test.ts`                                               |
| Oracle retry or checkpoint           | `src/__tests__/oracle-constellation.test.ts`                                       |
| Pipeline state or resume             | `src/__tests__/pipeline-engine.test.ts`                                            |
| MCP surface                          | `src/__tests__/control-plane-service.test.ts`                                      |
| Concerns registry or audit           | `src/__tests__/concerns-registry.test.ts`, `src/__tests__/concerns-audit.test.ts`  |
| Drift-audit pipeline or JIRA adapter | `src/__tests__/drift-audit.test.ts`, `src/__tests__/drift-jira-adapter.test.ts`    |
| Drift sync CLI (`helix drift sync`)  | `src/__tests__/drift-sync-command.test.ts`, `src/__tests__/drift-sync-e2e.test.ts` |

See `agents.md` for the append-only learning journal with category-tagged entries (architecture, testing, pattern, gotcha, process) and the concerns registry + audit design notes.

---

## Architecture

### High-Level Flow

```
User invokes CLI
       |
       v
  +-----------+     +----------------+     +----------------+
  | Session   |---->| Pipeline       |---->| Stage Runner   |
  | Manager   |     | Engine         |     | (per stage)    |
  +-----------+     +----------------+     +----------------+
                           |                       |
                    +------+------+         +------+------+
                    |             |         |             |
               +---------+  +--------+  +--------+  +--------+
               | Oracle  |  | Model  |  | Quality|  | Commit |
               | Constel.|  | Router |  | Gate   |  | Manager|
               +---------+  +--------+  +--------+  +--------+
                                |
                         +------+------+
                         |             |
                    +--------+    +--------+
                    | Claude |    | Codex  |
                    | SDK    |    | CLI    |
                    | Exec.  |    | Exec.  |
                    +--------+    +--------+
```

### Core Loop

The pipeline engine processes stages sequentially. For each stage:

1. **Build prompt** — combine stage description + session context + injected user guidance + scope discipline
2. **Execute model** — route to primary model, fall back if it fails, layer refinements on top
3. **Parse output** — extract structured findings, decisions, slices, or review results
4. **Run quality gate** — typecheck, test, lint, model-review checks with pass/fail thresholds
5. **Loop or proceed** — if the gate fails and `failAction` is `loop`, re-execute with feedback prepended
6. **Persist checkpoint** — save stage result, advance `currentStageIndex`, write to disk

For implementation stages with slices, the engine expands into a per-slice inner loop:

1. **Check entry conditions** — verify preconditions from the manifest
2. **Execute implementation** — model generates code changes within scope
3. **Evaluate exit criteria** — typecheck, lint, architecture review, test-lock, impact review
4. **Engage test lock** — all required tests must pass; regression suite runs
5. **Commit** — format, stage scoped files only, commit with JIRA key, post traceability comment

### Persistence Model

All state is persisted to disk as JSON:

```
.helix/sessions/<session-id>/
  session.json          # Full session state (slices, findings, decisions, stage history, jiraTickets ledger)
  progress.log          # Human-readable event log

.helix/concerns/        # Concerns registry (enforced/advisory YAMLs)
.helix/cache/           # Cached repo index, drift-key index

docs/sdlc-logs/<feature-slug>/
  journal.md            # Append-only narrative of what happened
  findings.md           # Structured findings for cross-session learning
  decisions.md          # Decision log with classifications
```

Sessions can be paused, resumed, and inspected at any time. The `currentStageIndex` and per-slice `status` fields are the resume cursors.

---

## Components

### 1. CLI (`src/cli.ts`)

The user-facing entry point. Parses arguments, loads `.env` for JIRA credentials (without sourcing the shell), builds config, and dispatches to the appropriate pipeline.

| Command                         | Description                                                     |
| ------------------------------- | --------------------------------------------------------------- |
| `helix audit "<title>"`         | Run holistic feature audit (11-stage pipeline)                  |
| `helix audit --concerns`        | Deterministic registry-wide concern audit (no pipeline, no LLM) |
| `helix fix "<description>"`     | Run bug-fix pipeline (7-stage pipeline)                         |
| `helix resume <session-id>`     | Resume a paused or interrupted session                          |
| `helix canary`                  | Bounded validation run (first 6 stages, tuned down)             |
| `helix smoke`                   | Quick structured-output probe                                   |
| `helix drift sync <session-id>` | Preview + dispatch drift findings as JIRA tickets (see §15)     |
| `helix status` / `helix list`   | Show all sessions and their state                               |
| `helix logs <id> [--follow]`    | Tail a session's progress log                                   |
| `helix pipelines`               | List available pipeline templates                               |
| `helix doctor`                  | Readiness report (`.helix/readiness-report.json`)               |

Key flags: `--scope`, `--jira`, `--spec`, `--budget` (default $200), `--auto-commit`, `--auto-approve`, `--interactive`, `--verbose`, `--timeout`, `--worktree`

### 2. Pipeline Engine (`src/pipeline/pipeline-engine.ts`)

The orchestrator. Takes a `Session` and `PipelineTemplate`, drives through stages. Handles:

- **Stage dispatch** by type (15+ stage types: deep-scan, oracle-analysis, plan-generation, implementation, testing, regression, concerns-audit, etc.)
- **Slice execution** — the inner loop for implementation stages
- **Quality gate evaluation** — runs checks, computes pass/fail, triggers loops
- **Checkpoint persistence** — saves after every stage/slice completion
- **Interactive control** — pause, resume, abort, skip, inject context, prioritize findings
- **Abort propagation** — terminates active model executions via AbortController
- **Resume logic** — scans from slice 0 for first non-committed slice; uses `skipToCommit` for locked-but-uncommitted slices

### 3. Model Router (`src/models/model-router.ts`)

Routes prompts to the right model based on `ModelAssignment`:

- **Primary execution** — first attempt with the designated model
- **Fallback chain** — if primary fails, try the fallback model
- **Layered refinement** — after success, pass output through additional models for review/refinement
- **Abort tracking** — maintains a Set of active AbortControllers for graceful termination

Three registered executors:

| Engine        | Executor            | How It Works                                                                                                                                                                                                                                      |
| ------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code` | `ClaudeSdkExecutor` | Uses `@anthropic-ai/claude-agent-sdk` to stream conversations. Supports system prompts, tool grants, budget caps, and per-turn cost tracking.                                                                                                     |
| `codex-cli`   | `CodexCliExecutor`  | Spawns `codex exec --json` as a child process. Parses JSONL events on stdout. Maps permission modes to sandbox levels (read-only / workspace-write / danger-full-access).                                                                         |
| `openai-api`  | `OpenAiApiExecutor` | Direct OpenAI API calls via dynamic import of `openai` SDK. Supports streaming, structured output (`response_format: json_schema`), cost extraction from usage metadata, abort/stall detection, and `maxBudgetUsd` safety cap. Added in ABLP-406. |

Model selection strategy: **Codex for deep code reading and implementation** (high turn counts, broad file access), **Claude Opus for architecture review and planning** (nuanced judgment, structured output), **Claude Sonnet for lightweight analysis** (oracles, canary stages), **OpenAI GPT-5 for cross-provider dissent** (Architecture oracle swap, Planner B in dueling-planners mode).

### 4. Oracle Constellation (`src/oracles/oracle-constellation.ts`)

Four specialized AI oracles that analyze findings from different perspectives, running in parallel:

| Oracle                | Default Model | Swap (when enabled)  | Tools                     | Focus                                                                                                   |
| --------------------- | ------------- | -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Codebase**          | Claude Sonnet | —                    | Read, Grep, Glob          | Code paths, redundancy, dead code, broken imports, unwired components                                   |
| **Architecture**      | Claude Opus   | GPT-5 (`openai-api`) | Read, Grep, Glob          | Platform principles (isolation, auth, stateless, traceability), error patterns, distributed correctness |
| **Testing**           | Claude Opus   | —                    | Read, Grep, Glob          | Coverage gaps, mock quality, false-confidence tests, missing E2E/integration                            |
| **Domain**            | Claude Opus   | —                    | Read, Grep, Glob          | Spec compliance, user stories, edge cases, error messages, feature completeness                         |
| **Platform**          | Claude Opus   | —                    | Read, Grep, Glob          | CLAUDE.md invariant violations, reinvented platform capabilities, wiring gaps, isolation model          |
| **Industry Research** | Claude Opus   | —                    | Read, WebFetch, WebSearch | Industry best practices, known failure modes, competitive implementations, relevant standards           |
| **OSS Library**       | Claude Opus   | —                    | Read, WebFetch, WebSearch | Existing npm/OSS libraries that could replace custom implementations; license/maintenance assessment    |

**Architecture oracle swap** (ABLP-406): When `HelixConfig.useOpenAiArchitectureOracle` is `true`, the Architecture oracle runs on `engine: 'openai-api', model: 'gpt-5'` via `resolveArchitectureOracle(config)`. This introduces genuine provider diversity in the quorum — three Claude voices plus one GPT-5 voice. Requires `OPENAI_API_KEY`. Enable via `--use-openai-architecture-oracle` CLI flag or `HELIX_USE_OPENAI_ARCHITECTURE_ORACLE=1` env var.

**Consensus mechanism**: Each oracle produces assessments (confirm/challenge/reprioritize) of existing findings and may propose new findings. A quorum of `ceil(successfulOracles / 2)` is required for any finding to be promoted or reclassified. New findings need quorum support. Decisions use majority voting with ANSWERED/INFERRED/DECIDED/AMBIGUOUS classification. The consensus protocol is engine-agnostic — mixed-engine oracle sets (Claude + OpenAI) operate identically to single-engine sets.

### 5. Session Manager (`src/session/session-manager.ts`)

CRUD for sessions. Creates a UUID-identified session directory, persists full state as JSON, supports loading/listing/updating. Also writes human-readable journals and structured findings/decisions to `docs/sdlc-logs/` for cross-session learning.

### 6. Slice System

Slices are **committable milestones** that group related findings into logical implementation units. Each slice has:

- **Manifest** — typed contract of file changes (`fileContracts`), entry conditions, and export contracts
- **Test Lock** — specific tests that must pass before the slice can commit, plus a regression suite
- **Exit Criteria** — typecheck, lint, architecture-reviewed, test-lock, impact-reviewed, exports-wired, no-new-findings
- **Impact Analysis** — dependent files, affected tests, risk level
- **Autonomy State** — risk score, confidence score, whether it can auto-commit

Slices flow through: `pending` -> `in-progress` -> `locked` -> `committed` (or `failed`)

### 7. Commit Manager (`src/pipeline/commit-manager.ts`)

Handles the actual git operations for autonomous commits:

1. Verifies test lock is engaged
2. Resolves JIRA key (finds or creates ticket if needed)
3. Computes allowed files from slice manifest
4. Runs prettier on eligible files
5. Stages only in-scope files (`git add`)
6. Commits with `[JIRA-KEY] type(scope): slice title` format
7. Posts commit SHA as JIRA comment for traceability
8. Warns about (but does not block on) out-of-scope working tree changes

### 8. Quality Gate (`src/pipeline/quality-gate.ts`)

Runs a configurable set of checks after each stage or slice:

| Check Type      | What It Does                                                           |
| --------------- | ---------------------------------------------------------------------- |
| `typecheck`     | `tsc --noEmit` scoped to affected packages                             |
| `test`          | `pnpm test:report:fast` or custom command                              |
| `lint`          | `prettier --check` on modified files                                   |
| `custom-script` | Arbitrary shell command                                                |
| `modified-test` | Verifies a test file was changed                                       |
| `model-review`  | AI review with structured output (blocking/advisory/deferred findings) |

Gates have a `passThreshold` (typically 1.0 = all must pass) and a `failAction` (`loop` to retry, `stop` to halt).

### 9. JIRA Integration (`src/integrations/jira-client.ts`)

Reads credentials from environment variables. All JIRA operations are graceful — failures never crash the pipeline.

- **Search** — JQL text search for existing tickets
- **Search by label** — exact-match JQL `labels = "…"` (used by drift sync)
- **Create** — new tickets with Atlassian Document Format (ADF) descriptions
- **Update** — field updates and comment additions
- **Enrich** — adds comprehensive session data (findings, impact, decisions, test coverage) as structured ADF comments
- **Find or Create** — reuses open tickets when possible, creates new ones when needed

### 10. Interactive Mode (`src/interactive/`)

When `--interactive` is passed, HELIX starts a REPL alongside the running pipeline. Users can:

- **Inject context** — add guidance that gets prepended to the next stage prompt
- **Skip stages** — mark a stage for skip
- **Pause/resume** — temporarily halt execution
- **Abort** — gracefully terminate with active execution cleanup
- **Prioritize** — escalate a finding to critical severity
- **Get status** — snapshot of current pipeline state

Input classification uses pattern matching with optional LLM fallback for ambiguous inputs.

### 11. Stage Output Parsing (`src/pipeline/stage-output-parsers.ts`, `stage-output-schema.ts`)

Six structured output schemas define what each stage type produces:

| Schema                | Stage Types                | Content                                                 |
| --------------------- | -------------------------- | ------------------------------------------------------- |
| `analysis-report`     | deep-scan, oracle-analysis | findings[] + decisions[]                                |
| `reproduction-report` | reproduce                  | testFile + steps + findings                             |
| `slice-plan`          | plan-generation            | slices with findings/files/tests/dependencies           |
| `plan-review`         | quality gate model-review  | slice assessments + blocking/advisory/deferred findings |
| `impact-analysis`     | manifest-compilation       | dependent files + affected tests + risk level           |
| `oracle-review`       | oracle substages           | assessments + new findings + decisions                  |

Each parser uses a **dual strategy**: try structured JSON extraction first, fall back to line-based parsing. This handles both models that produce clean JSON and models that embed structured data in prose.

### 12. Autonomy Policy (`src/pipeline/autonomy-policy.ts`)

Determines whether a slice can auto-commit or needs human review:

- **Risk scoring** (additive): base from impact analysis risk level, +3 for delete operations, +2 for 3+ dependents, +2 for export contracts, +5 for sensitive categories, +4 for sensitive file paths
- **Confidence scoring**: +2 for required tests defined, +2 for all tests passing, +2 for regression suite, +1-2 for affected test coverage, +3 for E2E evidence

Decision: `deferred-bulk-review` (auto-commit) when mode is `thresholded` AND risk <= max AND confidence >= threshold. Otherwise: `manual-checkpoint`.

### 13. Prompt Context (`src/pipeline/prompt-context.ts`)

Preloads once per run and persists on the session:

- **Instruction docs** — CLAUDE.md, agents.md from root and scoped packages
- **Feature spec excerpts** — from `docs/features/`
- **Prior findings/decisions** — from previous sessions on the same scope
- **Scoped code map** — files, exports, dependents, line counts

Stage-specific rendering: planning stages get compact versions (fewer files, shorter docs) to manage prompt size.

### 14. Pipeline Templates (`src/pipeline/templates/`)

Built-in templates:

**Holistic Audit** (13 stages) — for feature audits and enhancements:

1. Deep Scan (Codex, 45min) -> 2. Oracle Analysis (7 parallel oracles: Codebase, Architecture, Testing, Domain, Platform, Industry Research, OSS Library) -> 3. Findings Review (user checkpoint) -> 4. Plan Generation (Claude Opus, quality-gated, loops 3x) -> 5. Plan Approval (user checkpoint) -> 6. Manifest Compilation -> 7. Implementation (Codex + Claude review, per-slice) -> 8. Security Audit (Claude Opus 4.7, remediates blocking issues) -> 9. UX Design Audit (Claude Opus 4.7, remediates blocking issues) -> 10. E2E Testing (Codex + Claude layered) -> 11. Regression -> 12. Deferred Bulk Review -> 13. Doc Sync

**Bug Fix** (7 stages) — for targeted bug fixes:

1. Reproduce (write failing test) -> 2. Root Cause Analysis -> 3. Fix Approach Approval -> 4. Implement Fix -> 5. Regression Test -> 6. Code Review -> 7. Full Regression

**Canary** — takes the first 6 stages of the holistic audit and tunes down turns, budgets, timeouts, and effort levels for bounded validation runs.

**Drift Audit** (1 stage, deterministic) — runs `concerns-audit` across the repo to produce findings with `source` provenance. Designed to feed §15 drift-sync without needing an LLM.

Custom templates can be registered via `registerPipeline()`.

### 15. Concerns Registry + Drift Sync (`src/concerns/`, `src/integrations/drift-*.ts`)

A deterministic short-circuit that runs independently of the model-driven pipeline.

**Concerns Registry** — YAML-based rules under `.helix/concerns/enforced/` and `.helix/concerns/advisory/`. Each concern declares scope globs and detectors (`grep`, `ast`, `route`, `symbol-ref`, `schema`, `impacted-test`, `script`, `model-review`). The audit runtime silently skips `model-review` detectors in the deterministic path (they flow through oracle stages instead).

**Drift Audit Pipeline** — a one-stage pipeline that runs `runConcernsAudit` and lands findings on the session with `source: { concernId, concernTitle, detectorId }` provenance.

**Drift Sync CLI** — `helix drift sync <session-id>` groups findings by `(package, concernId)`, previews each batch as CREATE/UPDATE/SKIP against existing JIRA tickets (matched by the `helix-drift-<key>` label), and — with confirmation — dispatches tickets:

```
helix drift sync <session-id>                  # interactive: preview + confirm
helix drift sync <session-id> --dry-run        # preview only
helix drift sync <session-id> --auto-approve   # no prompt (cron-friendly)
helix drift sync <session-id> --project ABLP   # override project key
```

Resolution order for project key: `--project` flag → `$JIRA_PROJECT_KEY` → `ABLP` default.

Idempotency: `driftKey = sha1("helix-drift::{package}::{concernId}").slice(0,16)` becomes a JIRA label. Reruns search by label, classify open tickets as UPDATE, closed tickets as SKIP (no reopen), and never produce duplicate creates. An append-only `jiraTickets` ledger on `Session` records each attempt (`created`/`updated`/`skipped`), and `Finding.jiraKey` is backfilled on successful dispatch.

Entry points:

- `src/concerns/audit.ts` — deterministic audit runtime
- `src/pipeline/templates/drift-audit.ts` — one-stage pipeline template
- `src/integrations/drift-jira-adapter.ts` — batching, preview, ticket payload construction
- `src/integrations/drift-sync-command.ts` — interactive + auto-approve dispatch flow
- `src/__tests__/drift-sync-command.test.ts` — 7 unit tests with fake JIRA client + DI
- `src/__tests__/drift-sync-e2e.test.ts` — 3 E2E tests running the real audit pipeline into sync

---

## Highlights

### Multi-Model Intelligent eXecution

HELIX coordinates multiple AI models in a structured pipeline rather than using a single model for everything. Codex handles the heavy code reading/writing (high turn counts, broad file access), Claude Opus handles architectural judgment and review, and Claude Sonnet handles lightweight analysis. The layered model pattern allows refinement chains where one model's output is reviewed and improved by another — routing the right task to the right model is HELIX's core value proposition.

### Engineering Loops with Quality Gates

Every stage has a quality gate with configurable checks. The `failAction: 'loop'` pattern means that when a gate fails, the feedback is prepended to the prompt and the stage re-executes — creating a self-correcting engineering loop. This is the "Loops" in the name: HELIX doesn't just run stages linearly, it iterates until quality criteria are met. This is particularly powerful for plan generation, where the architecture review often catches issues the planner missed.

### Oracle Consensus

The four-oracle system (Codebase, Architecture, Testing, Domain) provides genuine multi-perspective analysis with a quorum-based consensus mechanism. This catches issues that a single model would miss — the testing oracle is skeptical of mocks, the architecture oracle enforces platform principles, the domain oracle checks spec compliance.

### Cross-Provider Quorum & Dueling Planners (ABLP-406)

Two opt-in capabilities that introduce genuine provider independence at HELIX's highest-leverage decision points:

**Dueling-planners convergence** — When `enableDuelingPlanners` is `true`, the `plan-generation` stage runs Planner A (Claude Opus) and Planner B (GPT-5) in parallel with the same prompt via `Promise.allSettled`. Both outputs are passed to Codex CLI (with `disableToolUse: true`) as unlabeled "Candidate A" and "Candidate B" for synthesis into Plan C. Failure modes: solo-pass through Codex when one planner fails; hard-abort when both fail or Codex synthesis fails (no silent fallback). Artifacts persisted: `plan-a.md`, `plan-b.md`, `plan-c.md`, `divergence-notes.md` in the session directory. Intermediate state checkpointed via `session.duelingPlanState` for resume. Enable via `--enable-dueling-planners` CLI flag or `HELIX_ENABLE_DUELING_PLANNERS=1`.

**Per-provider cost attribution** — `session.costByProvider` accumulates `{ totalUsd, callCount }` keyed by `engine:model` (e.g., `openai-api:gpt-5`) after every `modelRouter.execute()` call across the entire session.

New CLI flags: `--use-openai-architecture-oracle`, `--enable-dueling-planners`. Both default `false`. Require `OPENAI_API_KEY` when enabled (`helix doctor` validates).

New env vars: `HELIX_USE_OPENAI_ARCHITECTURE_ORACLE`, `HELIX_ENABLE_DUELING_PLANNERS`, `HELIX_OPENAI_MODEL` (default `gpt-5`).

Key implementation files:

- `src/models/openai-api-executor.ts` — OpenAI API executor
- `src/pipeline/engine/execute-dueling-plan-generation.ts` — dueling orchestrator
- `src/pipeline/engine/dueling-plan-synthesis-prompt.ts` — unlabeled synthesis prompt builder
- `src/pipeline/cost-accumulator.ts` — per-provider cost attribution

### Safe Autonomous Commits

The commit pipeline has multiple guards: test lock must be engaged, JIRA key must be real, files are scoped to the slice manifest, prettier runs before commit, out-of-scope changes are excluded. The autonomy policy adds risk/confidence scoring to determine whether human review is needed.

### Resumable Sessions

Every state change is persisted to disk. Sessions can be interrupted (Ctrl+C, crash, timeout) and resumed with `helix resume <id>`. The engine uses scan-back logic to find the first non-committed slice and `skipToCommit` to fast-forward locked-but-uncommitted slices.

### Interactive Steering

The `--interactive` flag enables real-time human guidance during pipeline execution. Users can inject context ("focus on the auth middleware"), skip stages, pause/resume, or prioritize specific findings — without restarting the pipeline.

### Scope Discipline

Deep-scan stages receive scope discipline prompts that constrain the AI to stay within declared scope. Narrow file scopes get hard boundaries; package scopes get "exhaust first, then one-hop" rules. This prevents AI models from scanning the entire repository when only a few files need attention.

### JIRA Traceability + Drift Sync

Every commit is linked to a JIRA ticket. If no ticket exists, HELIX searches for an open one or creates a new one. Commit SHAs are posted as JIRA comments. Session findings, impact analysis, and decisions are enriched onto the ticket as structured ADF comments. The drift-sync flow (§15) adds label-based idempotent ticket reuse for deterministic concern drift.

---

## How to Use HELIX

### Prerequisites

- Node.js >= 24
- `pnpm build --filter=@agent-platform/helix` (builds the CLI)
- JIRA credentials in environment: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`
- Codex CLI available on PATH (for stages using `codex-cli` engine)
- Anthropic API key (for Claude SDK executor)

### Run a Feature Audit

```bash
# Full holistic audit of a feature
helix audit "Web SDK Channel Parity" \
  --scope apps/runtime/src/websocket,apps/runtime/src/routes/sdk.ts,packages/web-sdk/src \
  --jira ABLP-193 \
  --spec docs/features/web-sdk-channel-parity.md \
  --auto-commit \
  --auto-approve \
  --verbose

# With interactive mode for real-time steering
helix audit "Auth Profile OAuth Flow" \
  --scope packages/shared-auth/src,apps/runtime/src/routes/auth \
  --interactive \
  --budget 150
```

### Run a Bug Fix

```bash
helix fix "Circuit breaker half-open probe doesn't re-open on failure" \
  --scope packages/circuit-breaker/src \
  --jira ABLP-195
```

### Run a Canary (Bounded Validation)

```bash
# Quick validation run — first 6 stages with reduced budgets
helix canary \
  --scope packages/helix/src/pipeline \
  --timeout 30m
```

### Run a Drift Audit + JIRA Sync

```bash
# Deterministic concerns audit — no LLM, no session
helix audit --concerns

# Or run through the drift-audit pipeline to get a session with findings:
helix audit "Drift audit: monorepo" --type drift-audit

# Preview drift findings as JIRA ops, then apply
helix drift sync <session-id> --dry-run
helix drift sync <session-id> --auto-approve
```

### Resume a Session

```bash
# List all sessions
helix status

# Resume a specific session
helix resume a44b46b5 --auto-approve --auto-commit --verbose

# Follow logs of a running session
helix logs a44b46b5 --follow
```

### Programmatic API

```typescript
import {
  PipelineEngine,
  SessionManager,
  ModelRouter,
  holisticAuditPipeline,
} from '@agent-platform/helix';

const config: HelixConfig = {
  workDir: process.cwd(),
  sessionDir: '.helix/sessions',
  journalDir: 'docs/sdlc-logs/my-feature',
  defaultModel: { engine: 'codex-cli', model: 'gpt-5.4', effort: 'high' },
  codexPath: 'codex',
  claudePath: 'claude',
  maxConcurrentOracles: 4,
  maxSliceRetries: 3,
  autoCommit: true,
  autoApprove: false,
  budgetLimitUsd: 200,
  verbose: true,
};

const sessionManager = new SessionManager(config);
const session = await sessionManager.create(workItem, holisticAuditPipeline);
const engine = new PipelineEngine(config, reporter);
await engine.run(session, holisticAuditPipeline);
```

---

## Future Work

### Planned Capabilities

1. **API-based model executors** — `openai-api` engine implemented (2026-04-19, ABLP-406): `OpenAiApiExecutor` registered in `ModelRouter`, supports streaming, structured output, cost extraction, abort/stall detection, and `maxBudgetUsd` safety cap. Used by the Architecture oracle swap and dueling-planners convergence features. `claude-api` engine remains declared in the type system but not yet implemented — that capability is tracked separately.

2. **Parallel slice execution** — Currently slices execute sequentially within an implementation stage. Slices without mutual dependencies could execute in parallel across isolated git worktrees, significantly reducing total pipeline time.

3. **Richer autonomy policies** — The current risk/confidence scoring is additive and heuristic. A learned model that observes which slices required human intervention vs. which auto-committed cleanly could improve the threshold over time.

4. **Cross-session learning** — Findings and decisions are persisted to `docs/sdlc-logs/` but aren't yet fed back into new session prompts systematically. A retrieval layer that surfaces relevant prior findings when scanning similar code paths would reduce duplicate work.

5. **Webhook/CI integration** — HELIX currently runs as a local CLI. A webhook-triggered mode could integrate with CI pipelines: PR opened -> HELIX audits the changed files -> posts findings as PR comments -> auto-fixes and pushes if approved.

6. **Cost optimization** — Tracking per-stage and per-slice costs to identify which stages are most expensive and whether cheaper models could substitute for certain checks without quality degradation.

7. **Pipeline composition** — The template system supports custom pipelines, but there's no way to compose pipeline fragments (e.g., "run only the oracle analysis on this feature, then stop"). A stage-level invocation API would enable more flexible workflows.

8. **Distributed execution** — Running model executions on remote workers rather than the local machine, enabling HELIX to be used in environments where the local machine doesn't have model access or sufficient compute.

9. **Richer JIRA integration** — Automatic status transitions (To Do -> In Progress -> In Review), sub-task creation for individual slices, and linking related tickets when findings span multiple features.

10. **Observability dashboard** — A web UI (possibly in the Studio app) that visualizes pipeline progress, slice status, finding heatmaps, oracle consensus, and cost accumulation in real time.

11. **Pipeline engine decomposition** — `pipeline-engine.ts` is 9K+ LOC. A refactor (strangler pattern, no behavior change) to split it into orchestrator + stage dispatch + slice loop + resume + checkpoint modules. Tracked separately.

12. **Daemon loop for drift sync** — Wrap drift-audit → drift-sync on a scheduled interval for unattended CI runs. Lower priority until the repo reaches a stable baseline.

For the full roadmap with phase-by-phase detail, see `docs/plans/helix-autonomous-harness-roadmap.lld.md`.
