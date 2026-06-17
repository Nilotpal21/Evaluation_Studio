# 13 — Evaluation Studio

**Implements the project-scoped autonomous evaluation control plane described across BRD_Agentic_AI_Platform.md, with additional product requirements for project-first evaluation, environment-specific journeys, project-level validators, benchmark-driven promotion, production monitoring, revert, and kill switch controls.**

## Goal

Build a dedicated **Evaluation Studio** inside each Project that allows a user to evaluate an Agent in either `Pre-prod` or `Prod` with minimal setup:

- The user first chooses a `Project`
- Then chooses `Pre-prod` or `Prod`
- Then selects an `Agent` from a filtered list
- In `Pre-prod`, the user also selects a `Version`
- In `Prod`, the user provides a `Duration`

Everything else is owned by the platform:
- evaluation plan generation
- persona inference
- scenario generation
- validator attachment
- benchmark comparison
- promotion decisioning
- production monitoring
- revert and kill switch support

This feature must work for both design and engineering as a clear build target, not just as product intent.

## Product principles

1. **Project is the operating boundary.**
   Evaluation, validators, benchmarks, dashboards, history, revert, and kill switch all scope to a Project.
2. **The environment choice changes the journey.**
   `Pre-prod` and `Prod` are not cosmetic filters. They produce different actions, inputs, execution methods, and dashboards.
3. **The system is autonomous by default.**
   The user should not manually define personas, scenarios, or run configuration during an evaluation.
4. **Validators are policy gates, not passive reports.**
   Their benchmarked outcomes drive pre-prod promotion decisions.
5. **The user always retains control.**
   Autonomous promotion is allowed, but `Revert` and `Kill switch` must always be available.

## Primary user stories

1. As a Process Owner, I want to pick a project, choose whether I am evaluating pre-prod or prod, and let the platform handle the rest.
2. As a Process Owner, I want pre-prod evaluation to automatically determine whether a version should be promoted.
3. As a Process Owner, I want production evaluation to run against a chosen time window of real production data.
4. As a Project Admin, I want to define custom validators and project-specific benchmark overrides once and have them apply automatically.
5. As a Project Admin or CU Admin, I want a real-time dashboard showing what is happening now, what the system decided, and whether I need to intervene.
6. As an operator, I want to be able to revert a promoted version or trigger a kill switch immediately.

## Information architecture

### Project-level navigation

Within a Project, Evaluation Studio introduces or requires these primary surfaces:

- `Overview`
- `Versions`
- `Evaluations`
- `Monitoring`
- `Validators`
- `Settings`

### Evaluation Studio routes

Recommended prototype / product routes:

1. `/projects/[projectId]/evaluations`
   Project-level Evaluation Studio landing page
2. `/projects/[projectId]/evaluations/new`
   New evaluation setup flow
3. `/projects/[projectId]/evaluations/[runId]`
   Evaluation run detail
4. `/projects/[projectId]/monitoring`
   Production monitoring dashboard
5. `/projects/[projectId]/validators`
   Project-scoped validator and benchmark management

## Core object model

### Entities

- `Project`
  - top-level operating boundary
- `Agent`
  - logical agent/app inside a project
- `AgentVersion`
  - immutable version snapshot used in pre-prod evaluation and promotion
- `Environment`
  - `pre_prod` or `prod`
- `EvaluationRun`
  - one execution of Evaluation Studio in either pre-prod or prod mode
- `Validator`
  - built-in or custom evaluator
- `ValidatorBenchmark`
  - pass/fail or threshold policy used by the product to make decisions
- `GoldenDataset`
  - curated expected-answer or expected-behavior dataset
- `KnowledgeBaseLink`
  - project or validator attachment to a KB or reference set
- `PromotionDecision`
  - product-made outcome from pre-prod evaluation
- `DeploymentRecord`
  - promotion or production deployment event
- `MonitoringWindow`
  - selected production time window under analysis
- `Incident`
  - drift, regression, policy breach, tool failure, or critical alert
- `KillSwitchEvent`
  - manual or automatic system halt action
- `RevertEvent`
  - rollback to prior production version

### Key relationships

- A `Project` contains many `Agents`
- An `Agent` has many `AgentVersions`
- An `EvaluationRun` belongs to one `Project`, one `Agent`, and one environment
- A pre-prod `EvaluationRun` also belongs to one `AgentVersion`
- A project owns many `Validators`
- A validator can link to zero or more `GoldenDatasets`
- A validator can link to zero or more `KnowledgeBaseLinks`
- A pre-prod run can create one `PromotionDecision`
- A production run can create zero or more `Incidents`

## Experience overview

## Screen 1: Evaluation Studio landing (`/projects/[projectId]/evaluations`)

### Header

- Breadcrumb: `Projects > Card Services > Evaluations`
- H1: *"Evaluation Studio"*
- Sub: *"Run autonomous evaluations in pre-prod or production. Promotion, monitoring, and controls stay scoped to this project."*
- Right side:
  - **New evaluation** button
  - Secondary link: **Open monitoring**
  - Kebab: `Validators`, `Settings`, `View history`

### Top summary strip

Four project-scoped cards:

| Card | Description |
|---|---|
| Latest pre-prod outcome | Most recent promotion decision |
| Latest prod health | Most recent production health state |
| Active production version | Current prod-bound version for the selected project/agent context |
| Open incidents | Drift, policy, latency, or tool issues requiring review |

### Evaluation history table

Columns:
- Run ID
- Mode (`Pre-prod` or `Prod`)
- Agent
- Version or Duration
- Started at
- Status
- Decision / Result
- Triggered by

Click row → evaluation run detail

## Screen 2: New evaluation setup (`/projects/[projectId]/evaluations/new`)

This is the primary branching flow and must be optimized for speed.

### Step 1: Project context

If launched from a project page, the project is preselected and read-only.

- Project name
- Project owner
- Active production agents count
- Pre-prod candidate agents count

### Step 2: Environment selection

Two large cards:

1. `Pre-prod`
   - subtitle: *"Evaluate a candidate version using simulated sessions and promotion policy."*
2. `Prod`
   - subtitle: *"Evaluate live production behavior using a selected production data window."*

Choosing one immediately changes subsequent fields.

### Step 3A: Agent and version selection for Pre-prod

When `Pre-prod` is selected:

- Agent picker
  - only shows agents with pre-prod candidates in this project
- Version picker
  - only shows versions available for pre-prod evaluation for the selected agent
- Summary card
  - selected version metadata
  - last evaluation result for that version if present
  - current production version for comparison

### Step 3B: Agent and duration selection for Prod

When `Prod` is selected:

- Agent picker
  - only shows agents currently deployed in production in this project
- Duration picker
  - `Last 24 hours`
  - `Last 7 days`
  - `Last 30 days`
  - optional custom range in the future, out of scope for phase 1
- Summary card
  - current production version
  - deployment timestamp
  - recent incident count

### Footer actions

- Primary CTA:
  - `Run Pre-prod Evaluation` when mode is pre-prod
  - `Run Production Analysis` when mode is prod
- Secondary: `Cancel`

## Execution model

## Pre-prod evaluation flow

Once the user submits:

1. ingest the selected agent version
2. read prompts, tools, workflow graph, config, KB links, golden datasets, and prior evaluation history
3. infer personas automatically
4. generate scenarios automatically
5. run simulations
6. attach built-in validators
7. attach project-level custom validators
8. load platform benchmark defaults
9. apply project benchmark overrides
10. score all outcomes
11. produce a product decision

### Allowed product decisions

- `Promote`
- `Hold`
- `Reject`
- `Re-run`

### Important requirement

The **product**, not the user, makes the default promotion decision in pre-prod based on validator benchmark results.

## Prod evaluation flow

Once the user submits:

1. resolve the selected production agent
2. resolve the currently active production version
3. fetch production sessions and traces for the selected duration
4. attach built-in validators
5. attach project-level custom validators
6. load platform benchmark defaults
7. apply project benchmark overrides
8. score production behavior
9. compare against baseline and prior windows
10. surface health, drift, regression, and incident findings

### Allowed production outcomes

- `Healthy`
- `Warning`
- `Drift detected`
- `Regression detected`
- `Critical incident`

Prod evaluation never directly promotes. It analyzes live behavior.

## Persona inference requirements

Personas are platform-generated and must not require manual authoring during evaluation setup.

### Input sources

- agent purpose and metadata
- prompts and system instructions
- tool definitions and workflows
- linked KB and golden assets
- historical runs and prior failures
- production behavior patterns when available

### Output requirements

Each inferred persona should include:

- identifier
- archetype / role
- primary goal
- knowledge level
- behavior style
- risk profile
- ambiguity pattern
- likely failure triggers
- expected successful outcome

Personas are used internally to generate scenarios and simulations. They do not need to be editable in phase 1.

## Validator framework

## Built-in validators

The platform should ship with a standard validator stack. At minimum:

- `Task completion`
- `Routing correctness`
- `Response correctness`
- `Instruction adherence`
- `Clarification quality`
- `Tool-use correctness`
- `Groundedness / hallucination`
- `Policy compliance`
- `PII / authorization correctness`
- `Latency`
- `Cost`
- `Regression / drift detection`

## Custom validators

Projects must be able to define reusable custom validators in a dedicated tab.

### Custom validator capabilities

- name
- description
- validator type
  - rule-based
  - LLM-as-judge
  - programmatic
  - hybrid
- severity
- enabled environments
  - pre-prod
  - prod
  - both
- linked golden answers
- linked KB / reference sources
- threshold / pass criteria
- whether failure is blocking for promotion

### Important rule

Custom validators are defined once at the **Project** level and are auto-applied by the system when relevant. Users should not need to reattach them for every evaluation run.

## Benchmarks and policy ownership

Benchmark ownership is split intentionally:

- the **platform defines default benchmark ranges** for built-in validators
- the **project defines overrides and custom-validator thresholds**

### Platform default examples

- minimum task success rate
- maximum critical policy failures
- maximum allowed hallucination rate
- p95 latency threshold
- production drift tolerance

### Project override examples

- stricter routing correctness for financial flows
- zero tolerance for payment misrouting
- mandatory clarification under ambiguity
- project-specific cost caps

### Product behavior

The product must use the resolved benchmark set to make pre-prod promotion decisions automatically.

## Screen 3: Validators tab (`/projects/[projectId]/validators`)

This is a required separate project tab and should not be merged into Settings.

### Header

- H1: *"Validators"*
- Sub: *"Manage built-in and custom validators, benchmark overrides, golden answers, and knowledge links for this project."*
- Right side:
  - **New custom validator**
  - Filter dropdown: `All`, `Built-in`, `Custom`

### Table columns

- Validator name
- Type
- Scope
- Environments
- Severity
- Benchmark status
- Linked assets count
- Last used

### Validator detail panel / page

Each validator detail should show:

- overview
- logic type
- input signals
- pass/fail threshold
- benchmark origin
  - platform default
  - project override
- linked golden datasets
- linked KBs
- environments where active
- blocking behavior for promotion
- recent failure trend

### New custom validator flow

Form fields:

- name
- description
- method
- severity
- applies to
  - all agents in project
  - specific agents only
- environments
- benchmark threshold
- blocking or non-blocking
- attach golden answers
- attach KB / reference sources

## Screen 4: Evaluation run detail (`/projects/[projectId]/evaluations/[runId]`)

The run detail view changes depending on mode.

## Pre-prod run detail

### Header

- H1: *"Pre-prod evaluation · `card-dispute-triage` v24"*
- Sub: *"Project: Card Services · Run #214 · Started 14 minutes ago"*
- Status pill: `Running`, `Completed`, `Held`, `Promoted`, `Rejected`
- Right side:
  - `Open validators`
  - `View logs`
  - `Revert` when this run has already promoted
  - `Kill switch` when this run’s version is active in prod

### Real-time progress rail

Show live stages:

1. Ingestion
2. Persona inference
3. Scenario generation
4. Simulation
5. Validation
6. Benchmark scoring
7. Product decision
8. Promotion, if approved

Each stage should stream status updates as events, not rely on manual refresh.

### Results sections

- overall promotion decision
- benchmark pass/fail summary
- validator score table
- blocking failures
- scenario coverage
- top failing traces
- comparison to current production version

### Promotion outcome panel

Possible states:

- `Promoted automatically`
- `Held by policy`
- `Rejected by policy`
- `Re-run recommended`

When promoted, surface:

- previous prod version
- new prod version
- deployment timestamp
- `Revert` action

## Prod run detail

### Header

- H1: *"Production analysis · `card-dispute-triage`"*
- Sub: *"Project: Card Services · Last 7 days · Version v23 in production"*
- Status pill: `Running`, `Completed`, `Warning`, `Critical`
- Right side:
  - `Open monitoring`
  - `View incidents`
  - `Revert`
  - `Kill switch`

### Results sections

- evaluated time window
- live traffic volume analyzed
- validator results
- drift trend
- latency and cost trend
- incident summaries
- top failing production traces
- comparison to prior production window

## Screen 5: Monitoring dashboard (`/projects/[projectId]/monitoring`)

This is the dedicated production dashboard for real-time tracking and control.

### Header

- H1: *"Monitoring"*
- Sub: *"Real-time health, validator outcomes, drift detection, and operator controls for this project."*
- Right side:
  - Range selector
  - `Re-run production analysis`
  - `Kill switch`

### Core dashboard sections

1. **Current state strip**
   - active agent
   - active production version
   - current health
   - active alerts
2. **Live health metrics**
   - success rate
   - latency
   - cost
   - tool failure rate
   - policy incidents
3. **Continuous validator panel**
   - pass/fail trend by validator
4. **Drift panel**
   - baseline comparison
   - trend over time
5. **Incident stream**
   - critical, warning, info
6. **Trace inspector**
   - open a representative failing production session

### Real-time tracking requirement

The user must be able to answer:

- what is happening now?
- what decision did the system make?
- is production healthy?
- can I stop it immediately?

## Revert and kill switch

## Revert

Users must be able to revert a previously promoted production version.

### Revert behavior

- available when there is a prior safe production version
- creates a `RevertEvent`
- updates production binding back to the last known good version
- writes an audit entry
- updates monitoring state immediately

## Kill switch

Users must be able to stop unsafe behavior immediately.

### Supported scopes

- project-level
- agent-level
- version-level
- tool/integration-level

### Kill switch behavior

- confirmation dialog
- visible status change in dashboard
- immediate operational effect in the product model
- audit trail for who triggered it and why

### Automatic kill switch

Out of scope for phase 1 implementation, but the data model should support policy-triggered automatic kill switch activation later.

## Decisioning rules

## Pre-prod promotion policy

Promotion should be automatic when:

- all blocking validators meet benchmark
- critical policy violations are within allowed threshold
- regression versus current production version is within allowed tolerance
- confidence threshold is satisfied

### Hold should happen when

- non-critical benchmarks miss but are close
- coverage is insufficient
- the product needs a wider re-run

### Reject should happen when

- blocking validator fails
- policy threshold is exceeded
- critical regression is detected

## Audit requirements

Every one of the following must be written to the audit log:

- evaluation run start
- evaluation run completion
- benchmark resolution
- product promotion decision
- promotion event
- production analysis event
- revert event
- kill switch event
- custom validator creation or edit
- benchmark override creation or edit

## Notifications

The system should surface notifications for:

- pre-prod auto-promotion
- pre-prod hold or rejection
- drift detected
- critical production incident
- revert completed
- kill switch activated

Notifications can be prototype-level toasts or activity feed items in phase 1.

## Design requirements

1. The setup flow must be short and obvious.
   The mode fork should be visible and understandable within seconds.
2. `Pre-prod` and `Prod` dashboards must feel distinct.
   They are different workflows with different operator intent.
3. Validator configuration must be separated from evaluation execution.
   This is why `Validators` is a dedicated project tab.
4. Real-time status must be legible.
   Use progress rails, status pills, and event feeds, not only static scorecards.
5. High-risk controls must be prominent.
   `Revert` and `Kill switch` should never be buried.

## Engineering requirements

## Data requirements

Mock data should support:

- projects
- agents
- agent versions
- environment availability
- evaluation runs
- validators
- benchmarks
- golden datasets
- KB links
- incidents
- revert events
- kill switch events

## State requirements

At minimum, the prototype should support in-memory state changes for:

- selected project
- selected environment
- selected agent
- selected version or duration
- evaluation run creation
- simulated real-time stage progression
- product decision outcome
- promotion state
- revert state
- kill switch state

## Non-goals for phase 1 prototype

- real production traffic ingestion
- real validator execution
- real persona generation
- real promotion or deployment
- real websocket backend
- real policy engine

These can be simulated with mock events, but the UI and data model must clearly support the future production shape.

## Acceptance criteria

1. A user can start from a Project and create a new evaluation run.
2. Choosing `Pre-prod` filters agents appropriately and reveals version selection.
3. Choosing `Prod` filters agents appropriately and reveals duration selection.
4. A pre-prod run displays a staged autonomous flow and ends in a product decision.
5. A prod run displays a staged analysis flow and ends in health or incident results.
6. A dedicated `Validators` tab exists at project scope.
7. Custom validators can be viewed with linked golden answers or KB assets.
8. Benchmark ownership is visible as either `Platform default` or `Project override`.
9. A promoted pre-prod run exposes a `Revert` action.
10. Monitoring exposes a `Kill switch` control.
11. Audit-visible events exist for evaluation, promotion, revert, and kill switch actions.

## Suggested implementation order

1. Project-level evaluation landing page
2. New evaluation setup flow with pre-prod/prod branching
3. Mock data model for agents, versions, runs, validators, and benchmarks
4. Pre-prod evaluation run detail
5. Prod evaluation run detail
6. Validators tab
7. Monitoring dashboard
8. Revert and kill switch flows

## Out of scope

- multi-agent cross-project evaluation
- custom production traffic filters beyond duration
- editing inferred personas
- automatic canary rollout logic
- policy-triggered automatic kill switch execution
- multi-project benchmark inheritance beyond platform default and project override
