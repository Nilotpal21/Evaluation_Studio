# HELIX Autonomous Harness Roadmap -- Low-Level Design

**Status**: DRAFT
**Date**: 2026-04-10
**Scope**: `packages/helix/`
**Primary Goal**: Make HELIX a fast, repo-native autonomous harness for this monorepo by increasing intelligence per token, reducing exploratory turns, and preserving correctness.

## 1. Objective

HELIX already has access to frontier models, but it still spends too many turns rediscovering repo structure, re-reading files, and re-running broad orchestration flows. The next evolution is not "more models" or "more prompt text." The next evolution is a repo-specific harness that gives Codex and Claude Code the same kinds of advantages a post-trained SWE model gets from learned software-engineering priors:

- High-signal starting context
- Better stop policy
- Better tool policy
- Better recovery policy
- Better verification policy
- Better reuse of prior knowledge

The design target is a harness that starts close to the answer, not a harness that gets better at wandering.

## 2. Design Decisions

| #   | Decision                                                                                           | Rationale                                                                 | Alternatives Rejected                                                    |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| D-1 | Optimize for intelligence per token, not raw stage count                                           | Turn efficiency is the user-visible pain point                            | Adding more stages or more review without reducing exploration           |
| D-2 | Prefer deterministic repo intelligence over prompt-only guidance                                   | Structure should live in code and indexes, not only prose                 | Relying on longer prompts to steer generic models                        |
| D-3 | Use hybrid indexing: tree-sitter for broad scans, TypeScript semantic services for typed hot paths | This repo is TypeScript-heavy and benefits from signatures/references     | Tree-sitter alone for everything or tsserver for every file all the time |
| D-4 | Route to the lightest viable workflow first                                                        | Many tasks do not need full Deep Scan + Oracle + Plan + Manifest + Slices | Treating all work as a full autonomous audit                             |
| D-5 | Failure should produce advice and resumable state, not dead ends                                   | Hard failure destroys operator trust and wastes prior work                | Timeout/fail/restart loops                                               |
| D-6 | Verification must be targeted and cacheable                                                        | Broad test and gate reruns dominate slice time                            | Re-running every proof step on every retry                               |

## 3. Current Change Surface

### Existing Core Files

- `packages/helix/src/pipeline/templates/holistic-audit.ts`
- `packages/helix/src/pipeline/templates/bug-fix.ts`
- `packages/helix/src/pipeline/pipeline-engine.ts`
- `packages/helix/src/pipeline/prompt-context.ts`
- `packages/helix/src/pipeline/repo-index.ts`
- `packages/helix/src/pipeline/manifest-compiler.ts`
- `packages/helix/src/pipeline/stage-runner.ts`
- `packages/helix/src/pipeline/quality-gate.ts`
- `packages/helix/src/pipeline/workspace-status.ts`
- `packages/helix/src/models/model-router.ts`
- `packages/helix/src/models/codex-cli-executor.ts`
- `packages/helix/src/models/claude-sdk-executor.ts`
- `packages/helix/src/oracles/oracle-constellation.ts`
- `packages/helix/src/session/`
- `packages/helix/src/ui/progress-reporter.ts`

### New Modules Expected

- `packages/helix/src/intelligence/` -- repo intelligence graph, signatures, routes, tests, patterns
- `packages/helix/src/router/` -- task routing and workflow selection
- `packages/helix/src/tools/` -- HELIX-native repo/tool adapters
- `packages/helix/src/evals/` -- repo-specific benchmark and replay corpus
- `packages/helix/src/knowledge/` -- session priors and recurrent blocker memory

## 4. Recommendation Coverage

This roadmap intentionally covers the full recommendation set:

1. Task router before pipeline start
2. Readiness-aware autonomy and routing depth
3. Repo index becomes true intelligence layer
4. TypeScript semantic indexing on hot paths
5. Route/API discovery and schema-aware analysis
6. Slice context packets as execution substrate
7. HELIX-native tools instead of shell-heavy exploration
8. Batching and prefetch in harness
9. Executor-level efficiency policy and stop policy
10. Parallel tool directives and batched execution guidance
11. Budget enforcement and operator-visible spend control
12. Repo invariants compiled into code
13. Test intelligence layer
14. Coverage-aware verification for changed code
15. Verification caching and evidence reuse
16. Advisory-based recovery generalized across the harness
17. Resume becomes first-class and stateful
18. Incremental re-planning after partial success/failure
19. Local priors and cross-session learning from past HELIX runs
20. Intelligence-per-token telemetry
21. Repo-specific HELIX eval set and shadow-mode promotion
22. Parallel slice execution where the DAG allows it
23. Delivery workflow automation: PR creation, CI follow-up, JIRA linkage
24. Supporting DX and hygiene: config validation, cost dashboard, session GC, CLI robustness

## 5. Implementation Phases

### Priority Bands

The roadmap is intentionally split into core autonomy work vs supporting work:

- **Core now**:
  - task router
  - slice context packets
  - repo intelligence layer
  - native HELIX tools
  - executor budgets and loop suppression
  - test intelligence and verification caching
  - eval harness and telemetry
- **Core later**:
  - parallel slice execution
  - deeper route/schema/git-history intelligence
  - delivery workflow automation
- **Supporting hygiene**:
  - real-time cost dashboard
  - config schema validation
  - session GC / archival
  - CLI input hardening and UX fixes

The core principle is that HELIX should first become more decisive and less exploratory before it becomes more automated around delivery.

### Phase 0: Baseline, Telemetry, and Eval Harness

**Goal**: Measure where turns, time, and cost are going before changing behavior.

**Workstreams**:

1. Add stage and executor telemetry for:
   - time-to-first-diff
   - read/grep/glob/bash turn counts
   - repeated file reads
   - repeated grep patterns
   - quality-gate retry counts
   - resume success rate
   - first-pass slice success rate
   - cost per successful slice
   - budget exhaustion rate
   - resume success after advisory
2. Build a repo-specific eval corpus from historical HELIX sessions and real tasks.
3. Add replayable benchmark inputs for:
   - targeted bug fix
   - route/auth isolation fix
   - UI slice
   - cross-package seam change
   - broad feature audit
4. Add shadow-mode evaluation hooks so new router/packet/budget policies can be compared before default rollout.

**Files Touched**:

- `packages/helix/src/types.ts`
- `packages/helix/src/pipeline/pipeline-engine.ts`
- `packages/helix/src/models/codex-cli-executor.ts`
- `packages/helix/src/models/claude-sdk-executor.ts`
- `packages/helix/src/ui/progress-reporter.ts`
- `packages/helix/src/evals/*` (new)

**Exit Criteria**:

- [ ] HELIX emits per-stage and per-executor efficiency telemetry in persisted session state
- [ ] A replayable eval corpus exists for at least 20 real repo tasks
- [ ] We can compare workflows by time, turns, cost, and pass rate
- [ ] Shadow-mode comparison is available for at least one policy class
- [ ] Baseline report exists for current `holistic-audit`, `bug-fix`, and canary flows

**Rollback**: Disable new telemetry fields and keep eval data out of runtime paths.

---

### Phase 1: Task Router and Workflow Compression

**Goal**: Route work to the lightest viable workflow instead of defaulting to full autonomous audit.

**Workstreams**:

1. Add a pre-pipeline task classifier that chooses:
   - `review-only`
   - `targeted-fix`
   - `test-only`
   - `implementation-only`
   - `bug-fix`
   - `full-audit`
2. Define routing signals:
   - user intent
   - scope size
   - known changed files
   - risk level
   - number of packages touched
   - whether the work item already has findings or a plan
3. Split `holistic-audit` into reusable subflows instead of one default heavy path.
4. Feed readiness and autonomy signals into routing:
   - module criticality
   - coverage signal
   - maturity/ownership
   - max safe autonomy posture
5. Add operator-visible rationale for why HELIX chose a workflow.

**Files Touched**:

- `packages/helix/src/models/model-router.ts`
- `packages/helix/src/pipeline/templates/holistic-audit.ts`
- `packages/helix/src/pipeline/templates/bug-fix.ts`
- `packages/helix/src/cli.ts`
- `packages/helix/src/router/*` (new)
- `packages/helix/src/readiness/runtime-policy.ts`
- `packages/helix/src/pipeline/autonomy-policy.ts`

**Exit Criteria**:

- [ ] At least 3 lightweight workflows exist and are selectable automatically
- [ ] Router decision is persisted and visible in session state/output
- [ ] At least 30% of historical eval tasks avoid the full audit pipeline
- [ ] Routing depth adapts to readiness/autonomy signals for critical vs mature modules
- [ ] Lightweight routing does not regress task success on the eval set

**Rollback**: Keep router in recommend-only mode and allow forced fallback to the current pipeline templates.

---

### Phase 2: Repo Intelligence Layer

**Goal**: Replace broad discovery turns with deterministic repo intelligence.

**Workstreams**:

1. Expand the cached repo index with:
   - exported symbol signatures
   - interface/type alias summaries
   - call-site and symbol-reference summaries where feasible
   - route and middleware surface
   - auth and project/tenant boundary annotations
   - package seam graph
   - symbol-to-file references
2. Add TypeScript semantic indexing for:
   - function/method signatures
   - interface shapes
   - type aliases
   - references/definitions for hot-path files
3. Build machine-readable catalogs for:
   - codebase patterns
   - common invariants
   - historical failure hotspots
   - git-history risk signals and co-change relationships
4. Expose this data through a stable internal API instead of prompt-only rendering.

**Files Touched**:

- `packages/helix/src/pipeline/repo-index.ts`
- `packages/helix/src/pipeline/prompt-context.ts`
- `packages/helix/src/intelligence/*` (new)
- `packages/helix/src/types.ts`

**Exit Criteria**:

- [ ] HELIX can answer symbol/signature/reference queries without shelling out
- [ ] Prompt context includes typed intelligence where available
- [ ] Route/auth boundary metadata is queryable for runtime packages
- [ ] Schema and data-model summaries are available for persistence-heavy areas
- [ ] Pattern catalog is generated, persisted, and invalidated incrementally

**Rollback**: Keep tree-sitter-only index as a fallback and gate semantic indexing behind config.

---

### Phase 3: Slice Context Packets and Native HELIX Tools

**Goal**: Start implementation and review stages with the real working set already assembled.

**Workstreams**:

1. Introduce a `SliceContextPacket` containing:
   - full source for target files
   - dependent file excerpts
   - imported type signatures
   - required tests and likely impacted tests
   - local conventions and invariants
   - recent git context near touched files
   - structured `agents.md` / `AGENTS.md` excerpts for touched packages only
2. Replace shell-heavy exploration with HELIX-native tools:
   - `GetSlicePacket`
   - `FindSymbol`
   - `FindReferences`
   - `GetRouteInfo`
   - `GetAuthBoundary`
   - `GetImpactedTests`
   - `ExplainInvariant`
3. Prefetch common adjacent evidence when the model requests a likely hot file.
4. Make implementation, review, and planning prompts packet-first.
5. Generate machine-oriented package knowledge alongside human instructions rather than overloading prose docs.

**Files Touched**:

- `packages/helix/src/pipeline/stage-runner.ts`
- `packages/helix/src/pipeline/manifest-compiler.ts`
- `packages/helix/src/pipeline/prompt-context.ts`
- `packages/helix/src/pipeline/model-review-prompts.ts`
- `packages/helix/src/intelligence/*`
- `packages/helix/src/tools/*` (new, if implemented as native tool adapters)

**Exit Criteria**:

- [ ] Implementation stages receive slice packets by default
- [ ] Median exploratory read/grep turns per slice drop materially on the eval set
- [ ] Target files and required tests are available before the first implementation step
- [ ] Slice packets stay within model prompt budgets via deterministic truncation policy
- [ ] Native repo tools cover the top 80% of current shell/read/grep exploration patterns

**Rollback**: Keep packet generation optional and fall back to current issue briefs.

---

### Phase 4: Executor Efficiency Policy and Stop Policy

**Goal**: Reduce wandering behavior through harness-level policy, not only hard failure.

**Workstreams**:

1. Add executor-side budgets for:
   - total turns
   - exploration turns
   - repeated file reads
   - repeated search patterns
2. Add repeated-read and repeated-search suppression with automatic summary injection.
3. Add explicit efficiency rules and parallel tool directives to implementation/review prompts.
4. Enforce session and stage budget awareness:
   - cumulative spend tracking
   - pause before budget exhaustion
   - operator-visible next action when nearing limits
5. Add soft deadline behavior:
   - summarize current evidence
   - suggest next action
   - continue only if unresolved value remains
6. Batch file reads and symbol lookups automatically when the next likely requests are obvious.
7. Tune stage-level budgets to reflect workflow intent instead of broad default caps.

**Files Touched**:

- `packages/helix/src/models/codex-cli-executor.ts`
- `packages/helix/src/models/claude-sdk-executor.ts`
- `packages/helix/src/pipeline/pipeline-engine.ts`
- `packages/helix/src/oracles/oracle-constellation.ts`
- `packages/helix/src/pipeline/default-stage-prompts.ts`
- `packages/helix/src/types.ts`

**Exit Criteria**:

- [ ] Executors detect and suppress obvious repeated-read loops
- [ ] Exploration and implementation turns are tracked separately
- [ ] Session budget limits pause cleanly before overrun
- [ ] Median total turns per successful slice fall on the eval set without reducing pass rate
- [ ] Soft deadlines produce summaries and guidance instead of only terminal failure

**Rollback**: Disable suppression heuristics and keep metrics-only mode if false positives appear.

---

### Phase 5: Verification Intelligence and Evidence Reuse

**Goal**: Make correctness cheaper by shrinking and caching proof obligations.

**Workstreams**:

1. Build a test intelligence layer:
   - likely source-to-test mappings
   - package-level smoke test selection
   - historically flaky or unrelated suites
   - known seam-level regression bundles
2. Add coverage-aware verification for changed code:
   - changed file / changed function coverage checks
   - uncovered-line reporting for slice-owned files
3. Replace broad inherited regression carry-forward with impacted-test policy.
4. Cache verification evidence keyed by:
   - file content hash
   - package graph
   - test command
   - gate input set
5. Compile repo invariants into deterministic checks where possible:
   - auth middleware presence
   - project/tenant scoping
   - route ordering
   - build-before-test requirements
   - E2E quality rules
6. Reduce repeated model-review work by reusing unchanged proof packets.

**Files Touched**:

- `packages/helix/src/pipeline/manifest-compiler.ts`
- `packages/helix/src/pipeline/quality-gate.ts`
- `packages/helix/src/pipeline/pipeline-engine.ts`
- `packages/helix/src/pipeline/workspace-status.ts`
- `packages/helix/src/intelligence/*`
- `packages/helix/src/knowledge/*` (new)

**Exit Criteria**:

- [ ] Required test selection is narrower and more accurate than current inherited regression behavior
- [ ] Coverage checks surface changed-code gaps without forcing broad repo-wide coverage runs
- [ ] Verification evidence is reused across retries when inputs are unchanged
- [ ] Deterministic invariant checks replace a measurable share of model review work
- [ ] Slice gate time drops materially on the eval set without higher regression leakage

**Rollback**: Disable evidence reuse by config and keep current gate behavior as a conservative fallback.

---

### Phase 6: Recovery, Resume, and Session Priors

**Goal**: Make HELIX resilient, stateful, and progressively smarter about this repo.

**Workstreams**:

1. Generalize failure advisory to all major blocking modes:
   - timeouts
   - loop limits
   - structured-output exhaustion
   - unrelated test failures
   - workspace noise
   - repeated gate failure
2. Make resume restore:
   - stage-local evidence
   - advisories
   - prior read summaries
   - pending decisions
   - retry budget state
3. Persist recurring priors:
   - noisy paths
   - common blockers
   - known findings by file/category
   - typical fix shapes by package
   - expensive commands and flaky suites
   - successful recovery actions
4. Add incremental re-planning after partial success:
   - completed slices remain locked
   - failed slice gets targeted re-plan first
   - future slices revalidate entry conditions before broad re-plan
5. Feed priors into routing, packet generation, and failure recovery.

**Files Touched**:

- `packages/helix/src/pipeline/pipeline-engine.ts`
- `packages/helix/src/session/*`
- `packages/helix/src/ui/progress-reporter.ts`
- `packages/helix/src/knowledge/*`
- `packages/helix/src/cli.ts`

**Exit Criteria**:

- [ ] Terminal failures pause with actionable advice by default
- [ ] Resume restores advisory and evidence state instead of restarting blind
- [ ] Priors are persisted and applied on later similar sessions
- [ ] Partial-failure re-planning avoids restarting full plans when only one slice changes
- [ ] Resume success rate improves measurably on the eval set

**Rollback**: Keep priors read-only and advisory in observe mode until false-positive risk is low.

---

### Phase 7: Parallelism and Delivery Automation

**Goal**: Increase end-to-end throughput once the single-slice workflow is already efficient and reliable.

**Workstreams**:

1. Add DAG-aware slice scheduling for independent slices.
2. Use separate worktrees for parallel slice execution with conservative merge/conflict policy.
3. Add delivery workflow automation:
   - optional branch/PR creation after successful commits
   - generated PR summary from findings, slices, and test evidence
   - JIRA linkage and CI follow-up
4. Keep parallelism gated by confidence and conflict-risk heuristics.

**Files Touched**:

- `packages/helix/src/pipeline/pipeline-engine.ts`
- `packages/helix/src/worktree-manager.ts`
- `packages/helix/src/cli.ts`
- `packages/helix/src/pipeline/*` (new scheduler module)

**Exit Criteria**:

- [ ] HELIX can run at least 2 independent slices in parallel when the DAG allows it
- [ ] Parallel execution is gated off automatically for high-conflict plans
- [ ] Optional PR creation works with generated summary and JIRA linkage
- [ ] Parallel mode improves end-to-end wall-clock on suitable eval tasks without lowering pass rate

**Rollback**: Keep parallelism opt-in and preserve sequential execution as the default fallback.

---

### Phase 8: Continuous Tuning Against Repo-Specific Evals

**Goal**: Make HELIX self-improving against this repo, not generic benchmarks.

**Workstreams**:

1. Run every phase change against the HELIX eval corpus.
2. Track intelligence-per-token metrics over time.
3. Add shadow-mode A/B runs for:
   - router policy
   - packet quality
   - executor suppression heuristics
   - test selection policy
4. Promote policies only when they improve:
   - pass rate
   - median turns
   - wall-clock time
   - operator intervention rate
   - recovery rate

**Files Touched**:

- `packages/helix/src/evals/*`
- `packages/helix/src/cli.ts`
- `packages/helix/src/types.ts`
- CI/reporting integration as needed

**Exit Criteria**:

- [ ] Every major HELIX policy ships behind eval coverage
- [ ] We can compare current harness vs candidate harness on repo-native tasks
- [ ] Intelligence-per-token metrics trend in the right direction over multiple iterations
- [ ] Policy regressions are caught before rollout

**Rollback**: Keep new policies behind flags and require eval pass before default enablement.

## 6. Supporting DX and Hygiene Track

These are important, but they should not block the core autonomy program:

- Real-time cost dashboard in progress output
- `helix.config.yaml` schema validation and better startup diagnostics
- Session cleanup / archival / garbage collection
- CLI answer hardening so flags or shell noise are not interpreted as checkpoint answers
- Small operator UX improvements around resume, worktree visibility, and budget status

Ship these opportunistically alongside the main phases, but do not let them displace the core work of routing, packets, tools, budgets, verification, and evals.

## 7. Cross-Phase Concerns

### Prompt Strategy

- Prompts should shrink as repo intelligence improves.
- New context should be structured, queryable, and selective.
- Do not compensate for missing tools with more prose.

### Safety and Correctness

- Prefer deterministic checks for repo invariants where possible.
- Keep model judgment for ambiguity, tradeoffs, and code synthesis.
- Never allow recovery shortcuts to silently widen scope or commit unrelated files.

### Performance

- All indexes must be incrementally invalidated.
- Semantic indexing should be targeted to hot paths and changed files.
- Packet assembly should be cacheable across retries and resumes.

### Rollout

- Every phase should ship behind feature flags or config gates.
- Run new policies in shadow or observe mode before making them default.

## 8. Success Metrics

- 50%+ reduction in exploratory turns per successful slice
- 30%+ reduction in wall-clock time for targeted fix workflows
- Higher first-pass gate success for slices
- Lower cost per successful slice
- Higher resume success rate after interruption or timeout
- Lower operator frustration: fewer dead-end failures, fewer blind reruns

## 9. What Not to Prioritize First

- Vector DB or embeddings as the first intelligence layer
- More default oracles or more stages
- Longer prompts as the primary strategy
- Hand-maintained machine knowledge in `agents.md`

## 10. Open Questions

1. Which packages should receive TypeScript semantic indexing first: runtime, studio, or shared packages?
2. Should slice packets be generated eagerly for every slice or only on the active slice?
3. What confidence threshold is required before impacted-test selection can replace inherited regression suites by default?
4. Should priors be stored globally for HELIX or namespaced by package/domain?
5. Which metrics should be used as promotion gates for policy changes: pass rate first, or cost/latency first?
