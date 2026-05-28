# Digression Certification

Small local-dev project for manually certifying canonical digression behavior.

## What This Example Covers

- `INTENT` used as a stable semantic id
- lexical fallback through `KEYWORDS`
- post-match `CONDITION` gating
- ordered `DO` execution with `RESPOND`, `SET`, `CLEAR`, `RESUME`, and `GOTO`
- global digressions versus step digressions
- enum validation on gathered values during normal step execution
- negative behavior when `KEYWORDS` are absent or a digression is out of scope

## Project Layout

```text
digression-certification/
  project.json
  agents/
    digression_certification_agent.agent.abl
  config/
    project-settings.json
  environment/
    env-vars.json
  certification/
    manual-test-matrix.md
```

## Entry Agent

- `Digression_Certification_Agent`

## How To Import

Studio:

1. Open local Studio.
2. Create or open a project.
3. Import the folder `examples/digression-certification`.
4. Start a chat with `Digression_Certification_Agent`.

CLI:

```bash
abl import ./examples/digression-certification
```

## Quick Smoke Run

```text
User: guided
User: help
User: VPN outage
User: high
```

Expected result:

- `help` responds without leaving the current step
- `VPN outage` is still collected as the issue
- the final summary includes `last digression: help_request`

## Manual Certification Pack

Use [manual-test-matrix.md](/Users/prasannaarikala/projects/f-1/abl-platform/examples/digression-certification/certification/manual-test-matrix.md) for the full positive, negative, and edge-case conversation set.
