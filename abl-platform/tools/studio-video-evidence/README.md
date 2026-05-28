# Studio Video Evidence

Reusable Studio UI launch, navigation, capture, and scenario scaffolding for video-based proof.

## Quick launch and capture

List the built-in capture scenarios:

```bash
pnpm studio:video:evidence -- --list
```

List the reusable Studio surfaces the harness knows how to open:

```bash
pnpm studio:video:evidence -- --list-surfaces
```

Capture a known Studio surface without writing a custom scenario:

```bash
pnpm studio:video:evidence -- --surface agent-chat --headed
```

The `--surface` shortcut automatically runs the generic `studio-surface-capture` scenario.

## Reuse existing Studio state

If you want to capture an existing project or agent instead of a disposable fixture, pass ids directly:

```bash
pnpm studio:video:evidence -- --surface agent-chat --email dev@kore.ai --project-id <projectId> --agent-name <agentName>
```

If ids are omitted, the harness creates a disposable project and, when required by the selected surface, a disposable static-reply agent. If you pass `--project-id` or `--agent-name`, prefer `--email` for a known dev-login user that already has access to that Studio state.

## Record a new scenario

Scaffold a new scenario file that already uses the shared fixture and navigation helpers:

```bash
pnpm studio:video:evidence -- --scaffold-scenario studio-agent-editor-proof --surface agent-editor
```

Scenario files placed under `tools/studio-video-evidence/scenarios/` are auto-discovered. After scaffolding, you can run the new scenario immediately:

```bash
pnpm studio:video:evidence -- --scenario studio-agent-editor-proof
```

## Artifact output

By default the tool writes manifests, screenshots, and videos under:

```text
.codex-artifacts/studio-video-evidence/
```

That folder is created automatically on first run and is intentionally gitignored so evidence can accumulate locally across threads without polluting the repo.

## Visual regression canary baseline

`audit-canary-baseline` captures eight high-traffic Studio surfaces in BOTH light and dark themes against a fresh disposable project. It is the lock-then-change workflow used by the Track 1 polish slices to ensure a token, hue, or typography change does not introduce regressions on adjacent surfaces.

```bash
pnpm studio:video:evidence -- --scenario audit-canary-baseline
```

Output structure:

```text
.codex-artifacts/studio-video-evidence/<run>/screenshots/
  light/
    insights-dashboard.png
    agents-list.png
    agent-chat.png
    sessions.png
    agent-editor.png
    evals.png
    connections.png
    insights-quality-monitor.png
  dark/
    <same eight surfaces>
```

Lock-then-change cadence for each polish slice:

1. Run `audit-canary-baseline` BEFORE the change → archive that run as the slice's pre-image baseline.
2. Make the slice change (token tweak, component swap, typography update).
3. Run `audit-canary-baseline` AFTER the change → archive as the post-image.
4. Diff baselines side-by-side. Surfaces NOT in the slice's blast radius MUST be pixel-stable; surfaces that ARE in the blast radius get explicitly re-baselined with the new render.

The 16-image set covers `--background`, `--foreground`, `--primary`, `--success`, `--warning`, `--error`, `--info`, the typography rhythm, the data-table tokens, the form/input tokens, and the Tab count guard — every blast radius the audit identified.

Theme injection is handled by `forceTheme(page, 'light' | 'dark')` in `lib/studio-chat.mjs`; it sets the `kore-theme-storage` localStorage key and the `data-theme` attribute via `addInitScript` so the very first paint already reflects the requested theme.
