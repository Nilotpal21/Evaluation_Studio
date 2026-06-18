# First-Time User Guide

This guide is for someone using the prototype for the first time. It explains the three most common tasks:

1. creating a new `Pre-prod` project
2. creating a new `Prod` project
3. checking and reopening existing projects

The prototype is intentionally lightweight. Some data is mocked, but the flows are designed to show the intended product behavior.

## What A Project Means

A `Project` is the operating boundary for:

- the selected agent
- evaluation runs
- validators
- knowledge base setup
- monitoring
- session evaluation
- operator controls such as revert and kill switch

When you create a project, you are not just naming a folder. You are creating the workspace in which the agent will be evaluated and monitored.

## Create A New Pre-prod Project

Use this when you want to qualify a candidate agent version before it is promoted.

### Steps

1. Open the `Projects` page.
2. Click `New Project`.
3. Enter a `Project name`.
4. Set `Environment` to `Pre-Prod`.
5. Select an `Agent`.
6. Select a `Version`.
7. Click `Create pre-prod project`.

### What happens next

After creation, the prototype routes you into the prefilled pre-prod evaluation flow for that project.

The system uses the stored project context:

- project name
- environment = `Pre-Prod`
- selected agent
- selected version

You do not need to re-enter those values manually if the routing is working correctly.

### What the user should do next

1. Review the prefilled evaluation setup.
2. Click `Run Pre-prod Evaluation`.
3. Wait for the run flow to start.

### Expected behavior after the run starts

Once the pre-prod run is launched:

- `Session evaluation` becomes available
- `Monitoring` becomes available
- the project can reopen into the launched run context instead of a generic landing page

### When to use Pre-prod

Use `Pre-prod` when:

- you are testing a candidate version
- you want validator-driven qualification
- you want the product to decide whether a version is promotable

## Create A New Prod Project

Use this when you want to analyze live production behavior for an agent that is already in use.

### Steps

1. Open the `Projects` page.
2. Click `New Project`.
3. Enter a `Project name`.
4. Set `Environment` to `Prod`.
5. Select an `Agent`.
6. Select a `Data duration`.
   Example options:
   - `1 hr`
   - `2 hr`
   - `1 day`
   - `2 day`
   - `7 days`
   - `30 days`
7. Click `Create prod project`.

### What happens next

After creation, the prototype routes you into the prefilled production analysis flow for that project.

The system uses the stored project context:

- project name
- environment = `Prod`
- selected agent
- selected duration

### What the user should do next

1. Review the prefilled production analysis setup.
2. Click `Run Production Analysis`.
3. Review the production run detail once it launches.

### Expected behavior after the run starts

Once the prod run is launched:

- the project stores the last launched run id
- reopening the same project should return you to the most relevant run flow
- `Monitoring` is available as a dedicated left-nav surface

### When to use Prod

Use `Prod` when:

- you want to analyze real production traffic
- you want to check drift, health, and incidents
- you want to inspect validator outcomes on live data

## Check Existing Projects

Use the `Projects` page to browse and reopen work that already exists.

### What to look for on the project card

Each project tile shows:

- project name
- short description
- owner name
- agent count
- created date
- environment chip:
  - `Pre-prod`
  - `Prod`

### How to reopen a project

1. Go to `Projects`.
2. Find the project tile.
3. Click the tile.

### Expected routing behavior

- for default seeded projects:
  - clicking the project opens `Evaluation Studio`
- for custom created projects:
  - if a run has already been launched, the project should reopen to the last launched run
  - if no run has been launched yet, the project should reopen into the prefilled evaluation setup for that project

## How The Left Navigation Works

Once inside a project, the main prototype surfaces are:

- `Evaluation Studio`
- `Mode hub`
- `Knowledge Base`
- `Session evaluation`
- `Monitoring`
- `Validators`
- `Docs`
- `Settings`

### Important behavior

`Session evaluation` and `Monitoring` are not just general pages. They are downstream project surfaces tied to the project state and run state.

For `Pre-prod`, they are expected to become meaningful after the evaluation run has started.

## What Session Evaluation Is For

`Session evaluation` is where the user inspects:

- stored sessions
- stored traces
- evaluator details
- input/output views
- transcript and session-level summaries

Use it when you want to drill into what happened in a seeded or launched evaluation run.

### Important interaction

- clicking a `Session ID` opens more details for that session
- clicking a `Trace ID` opens more details for that trace

Those detail panels are where the user can inspect transcripts, evaluation summaries, evaluator findings, trace trees, and input/output payloads.

## What Monitoring Is For

`Monitoring` is where the user inspects:

- production run progression
- health summaries
- incident counts
- drift behavior
- operator controls such as revert and kill switch

Use it when you want to understand live production health and follow-up actions.

## What Validators Are For

`Validators` is the project-level place to:

- view built-in validators
- create custom validators
- configure model-based validator logic
- manage benchmark behavior

Custom validator setup in the prototype currently focuses on:

- name
- description
- model
- model configurations
- prompt
- reference state

## What Knowledge Base Is For

`Knowledge Base` is where the user sets up knowledge for the project.

The creation wizard now begins with:

1. `General Settings`
   - knowledge base name
   - description

Then continues into the ingestion flow.

## Recommended First-Time Walkthrough

For a first-time demo, use this sequence:

1. open `Projects`
2. create a `Pre-prod` project
3. run the pre-prod evaluation
4. open `Session evaluation`
5. inspect a session and a trace
6. open `Validators`
7. review a validator configuration
8. open `Knowledge Base`
9. create a new knowledge base
10. create or open a `Prod` project
11. run production analysis
12. open `Monitoring`

This shows the full story of setup, evaluation, inspection, and governance.

## Prototype Limitations

This is still a prototype, so keep these points in mind:

- many datasets are dummy data
- some flows are persisted in local client state
- project creation is not backed by a real backend service
- routing logic is designed to demonstrate expected product behavior, not final infrastructure

## Summary

Use `Pre-prod` to qualify a candidate version before promotion.  
Use `Prod` to analyze live behavior over a chosen production window.  
Use existing project tiles to reopen the correct project context and continue evaluation, inspection, or monitoring.
