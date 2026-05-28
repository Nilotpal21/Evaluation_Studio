# HELIX Repo Readiness Contract

This document defines the first-pass human-owned contract that HELIX should use to understand and operate `abl-platform` safely.

The contract is split into two committed files:

- `helix.config.yaml`: repo topology, canonical commands, env expectations, service map, and doctor defaults
- `helix.verification.yaml`: module-specific evidence requirements, regression/E2E expectations, and autonomy ceilings

Generated runtime state belongs under `.helix/` and should not be committed.

## Readiness Checklist

HELIX should score the repo by checklist category instead of assuming one global confidence level.

| Category       | What HELIX checks                                                                                        | Why it matters                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `bootstrap`    | package manager, task runner, instruction files, install/build/test commands                             | HELIX needs one canonical way to get the repo into a runnable state   |
| `environment`  | `.env.example` or schema files per runnable app/service, required key names, shared-secret relationships | HELIX must understand configuration contracts without reading secrets |
| `commands`     | build, test, typecheck, lint, format, scoped package commands                                            | Confidence is impossible without executable verification paths        |
| `topology`     | apps, packages, services, ports, container-managed dependencies                                          | HELIX needs a map before it can reason about impact                   |
| `verification` | module policies, coverage signals, regression suites, E2E expectations                                   | Confidence must be module-specific, not repo-wide                     |
| `health`       | service start hints, smoke probes, health endpoints, doctor hooks                                        | Brownfield repos often need runtime evidence, not just unit tests     |
| `autonomy`     | recommended autonomy level, blockers, downgrade reasons                                                  | HELIX should adapt ambition to repo maturity                          |

## Opinionated Requirements

These are the repo-level expectations the doctor should enforce.

### Must Have

- A canonical `install`, `build`, `test`, and `formatWrite` command
- `buildBeforeTest = true` when the repo depends on compiled output
- A root `AGENTS.md` or equivalent instruction file
- At least one `.env.example` or schema file at the repo root
- A committed verification policy for critical modules

### Strongly Recommended

- Per-app `.env.example` or schema files
- Package-scoped test commands for critical packages
- At least one smoke or health probe that exercises the runtime end-to-end
- Service/port map for local development
- Module-specific regression and E2E expectations

### Gold Standard

- Coverage-to-module mapping
- Characterization-first policies for brownfield modules
- Explicit autonomy ceilings by module
- Health probes for each service boundary
- Known flaky suite registry and known dangerous path registry

## Environment Best Practices

HELIX should never rely on raw secrets stored in `.env` files. It should only inspect:

- `.env.example`
- `.env.template`
- schema files such as `env.schema.json`
- committed documentation describing required keys and relationships

Doctor should read key names, defaults, and documentation only. It must not print or persist secret values.

## `helix doctor` Output Format

The doctor command should emit a machine-readable report to `.helix/readiness-report.json` and a human-readable summary in the terminal.

### Top-Level Fields

- `formatVersion`: schema version for the report
- `generatedAt`: ISO timestamp
- `repo`: repo identity and path metadata
- `summary`: readiness level, autonomy recommendation, and pass/warn/fail counts
- `commands`: resolved canonical commands and their status
- `environment`: env-example discovery, required-key coverage, and missing contracts
- `services`: detected services, ports, start hints, and health-probe status
- `checklists`: flat list of checklist results
- `modules`: verification policy status for critical modules
- `nextActions`: short remediation items for the user

### Checklist Item Shape

Each checklist item should be a flat object with:

- `id`
- `category`
- `title`
- `status`: `pass`, `warn`, `fail`, or `skip`
- `severity`: `info`, `low`, `medium`, `high`, or `critical`
- `evidence`: short strings or paths proving the result
- `remediation`: one actionable next step

### Example Output

```json
{
  "formatVersion": 1,
  "generatedAt": "2026-04-05T12:34:56.000Z",
  "repo": {
    "id": "abl-platform",
    "displayName": "ABL Platform",
    "path": "/Users/prasannaarikala/projects/f-1/abl-platform"
  },
  "summary": {
    "readinessLevel": "L1",
    "autonomyRecommendation": "characterize-first",
    "counts": {
      "pass": 14,
      "warn": 5,
      "fail": 0,
      "skip": 2
    }
  },
  "commands": {
    "build": {
      "command": "pnpm build",
      "status": "pass"
    },
    "test": {
      "command": "pnpm test",
      "status": "pass"
    },
    "formatWrite": {
      "command": "npx prettier --write",
      "status": "pass"
    }
  },
  "environment": {
    "rootExamples": [".env.example"],
    "applicationExamples": [
      "apps/runtime/.env.example",
      "apps/studio/.env.example",
      "apps/admin/.env.example"
    ],
    "missingExamples": ["apps/search-ai/.env.example", "apps/search-ai-runtime/.env.example"]
  },
  "services": [
    {
      "id": "runtime",
      "status": "pass",
      "port": 3112,
      "startHint": "pnpm --filter @agent-platform/runtime dev"
    },
    {
      "id": "docling-service",
      "status": "pass",
      "port": 8080,
      "startHint": "docker compose up -d docling-service"
    }
  ],
  "checklists": [
    {
      "id": "bootstrap.build-command",
      "category": "bootstrap",
      "title": "Canonical build command is declared",
      "status": "pass",
      "severity": "high",
      "evidence": ["helix.config.yaml -> repo.canonicalCommands.build"],
      "remediation": ""
    },
    {
      "id": "environment.search-ai-example",
      "category": "environment",
      "title": "SearchAI has a committed env example",
      "status": "warn",
      "severity": "medium",
      "evidence": ["apps/search-ai/.env.example missing"],
      "remediation": "Add apps/search-ai/.env.example or an env schema file."
    }
  ],
  "modules": [
    {
      "id": "runtime-auth-and-isolation",
      "criticality": "critical",
      "status": "warn",
      "maxAutonomyLevel": "L1",
      "requiredRegressionSuites": ["runtime-fast", "repo-full"],
      "requiredE2ESuites": ["runtime-sdk-auth", "e2e-smoke"],
      "coverageSignal": "partial",
      "remediation": "Add or map a real HTTP isolation test before autonomous edits."
    },
    {
      "id": "helix-core",
      "criticality": "high",
      "status": "pass",
      "maxAutonomyLevel": "L2",
      "requiredRegressionSuites": ["helix-package"],
      "requiredE2ESuites": [],
      "coverageSignal": "good",
      "remediation": ""
    }
  ],
  "nextActions": [
    "Add env examples or schemas for runnable apps that still depend on local .env files.",
    "Map critical SearchAI flows to at least one real multi-service probe.",
    "Keep module policies current when a new critical package or service is introduced."
  ]
}
```

## Autonomy Semantics

- `L0`: audit only, no edits
- `L1`: edits allowed only with manual checkpoints
- `L2`: targeted autonomy for modules with solid regression evidence
- `L3`: high-confidence autonomy for modules with both regression and E2E proof

HELIX should always downgrade autonomy when required evidence is missing, stale, or obviously mocked.
