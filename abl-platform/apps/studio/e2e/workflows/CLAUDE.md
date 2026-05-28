# Workflow E2E Tests

**Before writing or modifying any file in this folder, read `agents.md` first.**

It contains:

- Folder layout — which files exist and what they cover
- Which spec file to add your test to (do NOT create new spec files without checking)
- Coverage tracker tables (nodes, triggers, monitor/debug)
- Import patterns (`from './helpers'`)
- data-testid registry, Zustand store patterns, selector rules
- Known engine gaps that block certain tests
- Learnings from past bugs so you don't repeat them

## Mandatory: Keep agents.md in sync

After completing work, you MUST update `agents.md`:

1. **Folder Layout section** — if you created, renamed, or deleted any file, update the tree
2. **Coverage tracker tables** — mark tests as Done, add new rows for new node types/triggers/features
3. **Testid registry** — if you added new `data-testid` attributes to components, add them to the table
4. **Known Engine Gaps** — if a gap was resolved or a new one discovered, update the table
5. **Learnings** — if you hit a non-obvious bug or pattern, append it so the next agent avoids it

This is not optional. `agents.md` is the source of truth for what exists in this folder. If it drifts from reality, the next agent will make wrong decisions about where to put tests, what's already covered, and what patterns to use.

## Coverage Claims

- Treat a single public-API regression as targeted coverage, not blanket "workflow E2E complete."
- If a test only proves local/dev wiring or bypasses the deployment path being discussed, say that explicitly in `agents.md` instead of implying production wiring is covered.
