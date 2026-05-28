# Porting Notes

This Charter bundle keeps the strongest teaching ideas from `/Users/prasannaarikala/projects/spectrum-concierge` while preserving the parts that already made `downloads/charter-concierge` the better runnable artifact.

## What was ported

- A dedicated auth-return path for account-specific billing work.
- A billing specialist with deterministic bill loading, credit policy checks, and supervisor routing.
- A richer docs set that answers the original ABL questions directly instead of folding everything into one spec note.
- A transcript index and a scenario review pass so every scenario is explicitly checked for teaching value.
- A stronger guardrail story through billing-specific input and output guardrails.

## What was intentionally not copied verbatim

- The Spectrum project-wide `.abl` guardrail bundle was not copied as-is. For the importable v2 bundle in this repo, agent-level guardrails are the safer fully working path.
- The Charter example stays smaller than Spectrum on purpose. It exercises the key constructs without adding extra lanes that would distract from the teaching goals.
- Tooling stays bound to one live mock service instead of multiple env-dependent tool bundles.

## Working principles for the port

1. Keep the bundle importable as a v2 project export.
2. Keep all agents parse-clean and compile-clean against the local ABL toolchain.
3. Prefer deterministic mock HTTP tools over placeholder prose.
4. Prefer honest scope notes over claiming features that the bundle does not actually encode.

## Review scope

The review pass for this port checked:

- construct coverage across all transcripts
- whether each scenario has a clear deterministic spine
- whether the scenario maps to real ABL authored surfaces in `agents/`
- whether the docs explain the same runtime shape the agents encode

Use [07-scenario-review.md](./07-scenario-review.md) for the detailed verdict by scenario.
