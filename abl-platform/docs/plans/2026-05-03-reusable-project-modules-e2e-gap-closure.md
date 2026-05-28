# Reusable Project Modules E2E Gap Closure Plan

## Goal

Make reusable project module execution fail consistently at the earliest safe boundary across Studio, import doctor, DB preflight, DSL materialization, and runtime execution. The target contract is: if Studio/import/deploy says a dependency is ready, runtime resolves the same scoped records with the same precedence.

## Design Principles

- **One resolution contract:** deployment preflight, Studio tool testing, and runtime execution must share environment precedence: target environment first, then `global`; legacy `null` environment records must not create new readiness lanes.
- **Tool-scoped secrets only:** `{{secrets.KEY}}` must resolve from auth profiles or DB ToolSecret records with an execution tool context. Env/config variables stay on `{{env.KEY}}` and `{{config.KEY}}`.
- **Warnings are not readiness:** import doctor and module previews should only report ready when the runtime path would also be able to resolve active, unexpired, scope-compatible dependencies.
- **Test-first locking:** each fix lands behind a focused regression that fails on the audited behavior before implementation.

## Implementation Slices

1. **Runtime preflight/store parity**
   - Lock runtime ToolSecret global fallback behavior in `RuntimeSecretsProvider`.
   - Lock deployment preflight so legacy `null` env vars no longer create a readiness lane that runtime cannot consume.
   - Implement ToolSecret `global` fallback in runtime store resolution, including expired exact-environment records.

2. **Studio authoring parity**
   - Lock Studio tool tests so `secrets.getSecret()` does not return env/config variables.
   - Keep `env.getEnvVar()` namespace-scoped with target/global fallback.
   - Keep legacy ToolSecret fallback tool-scoped by execution tool name, not secret key.

3. **Sandbox execution context**
   - Lock sandbox `secrets.get()` to pass the current sandbox tool name into the shared provider.
   - Preserve env/global access for sandbox `env.get()`.

4. **Import/contract validation**
   - Lock import doctor filters to active, unexpired, runtime-compatible auth profiles and env var lanes.
   - Stop emitting non-tool-scoped `requiredSecrets` as deployable runtime requirements; agent/profile prompt placeholders remain compile/runtime placeholders, not ToolSecret requirements.

## Verification

- Run focused Vitest files for runtime, compiler, Studio, and project-io.
- Run package builds/typechecks for affected packages after implementation.
- Run prettier on all touched files before any commit.
