---
name: studio-video-evidence
description: Use when you need repeatable Studio UI video proof for a bug fix, regression, or walkthrough. Runs the reusable `pnpm studio:video:evidence` tool, prefers existing built-in scenarios before creating new ones, and emits a manifest with video and screenshot artifact paths.
---

# Studio Video Evidence

Use this skill when a user wants Studio UI evidence, not just a unit test result.

## Default workflow

1. List available scenarios first when the right one is not obvious:
   `pnpm studio:video:evidence -- --list`
2. List reusable Studio surfaces when the user mostly needs launch/navigation help instead of a bespoke flow:
   `pnpm studio:video:evidence -- --list-surfaces`
3. Prefer a built-in scenario or the generic surface-capture path over writing a temporary Playwright spec.
4. Run the scenario and return the `video` and `manifestPath` from the JSON output:
   `pnpm studio:video:evidence -- --scenario studio-chat-single-turn`
5. If the user only needs to launch and navigate to a known Studio surface, use the surface shortcut:
   `pnpm studio:video:evidence -- --surface agent-chat --headed`
6. If the user needs a different message or reply, override the scenario options instead of cloning the scenario:
   `pnpm studio:video:evidence -- --scenario studio-chat-single-turn --user-message "Hello" --assistant-reply "Hi there"`
7. If the user wants a new reusable scenario, scaffold it from the harness instead of cloning an old file:
   `pnpm studio:video:evidence -- --scaffold-scenario studio-agent-editor-proof --surface agent-editor`
8. In isolated mode, the tool auto-builds missing Studio/runtime/web-sdk artifacts once and reuses them on later runs. If another thread is already building Studio, the tool waits for that build instead of trying to start a competing one.

## Current built-in scenario

- `studio-chat-single-turn`
  Creates a disposable project and static-response agent, opens Studio chat, sends one user message, and verifies the user bubble stays single-copy during the live response.
- `studio-surface-capture`
  Reuses the shared Studio harness to create or reuse a fixture, navigate to a named Studio surface, and capture ready-state video proof without a custom scenario file.

## When to add a new scenario

Only add a new scenario under `tools/studio-video-evidence/scenarios/` when:

- the existing scenario list cannot express the workflow with flags, and
- the new flow is likely to be reused in later threads.

Keep new scenarios thin. Reuse the shared helpers in `tools/studio-video-evidence/lib/studio-harness.mjs` and `tools/studio-video-evidence/lib/studio-chat.mjs`, and let `tools/studio-video-evidence/run.mjs` handle stack startup, video capture, manifest writing, and teardown. Scenario files placed under `tools/studio-video-evidence/scenarios/` are auto-discovered, so scaffolded scenarios become runnable without hand-editing an index file.

## Output contract

The tool writes a per-run folder under `.codex-artifacts/studio-video-evidence/` at the repo root by default. That local folder is created automatically on first run and is not meant to be committed. The tool prints a JSON manifest containing:

- `video`: preferred video artifact path
- `rawVideo`: original recorded `.webm`
- `screenshots`: captured screenshots
- `manifestPath`: persisted run manifest
- `metadata`: scenario-specific ids and message text
- `assertions`: scenario verification notes

Return those artifact paths directly to the user. If the user wants Jira evidence, attach `video` and use the manifest details in the ticket comment instead of reconstructing the proof from memory.
