# apps/studio — Claude rules

These rules apply only when working in `apps/studio/`. Root-wide rules live in `/CLAUDE.md`.

## Studio Route Handler Gotchas

CRITICAL: Studio Next.js API routes do NOT have AsyncLocalStorage tenant injection.

1. **Always scope Studio queries explicitly.** Every Mongoose query in `apps/studio` route handlers must include `tenantId: user.tenantId`. Never rely on ALS/database plugins to auto-scope Studio requests.
2. **`validateBody()` consumes the request body.** Reject unknown fields with Zod `.strict()` instead of calling `request.clone().json()` after validation and assuming the body is still safe to read again.

## Workflow E2E Tests

Workflow E2E tests live in `apps/studio/e2e/workflows/`. Read `agents.md` in that folder BEFORE adding/modifying workflow tests; update it after completing work (folder layout, coverage tables, testid registry, learnings).

## Design System (Studio UI)

When touching `apps/studio/src/components/**`:

- No hardcoded Tailwind palette (`bg-blue-500`, `text-red-400`). Use semantic tokens from `@agent-platform/design-tokens` (`design-token-lint.sh` warns).
- Never `bg-accent text-foreground` (invisible — accent is monochrome). Use `bg-accent text-accent-foreground` (`accent-foreground-lint.sh` blocks).
- Never native `<select>` — use `<Select>` from `components/ui/Select.tsx`; use `<FilterSelect>` for filter toolbars (`native-select-lint.sh` warns).

Full design-system reference: `studio-design-system` skill.
