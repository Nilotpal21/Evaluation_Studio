#!/bin/bash
#
# Claude Code PreToolUse hook: type-check affected packages before git commit.
#
# Why: Claude Code agents frequently generate code against imagined APIs
# (wrong prop names, missing exports, wrong function signatures). This hook
# catches those errors BEFORE they land in a commit.
#
# How: Detects which packages have staged changes, runs `tsc --noEmit` on each.
# If any package fails, the commit is blocked with a clear error message.
#

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only intercept git commit commands
if ! echo "$COMMAND" | grep -qE '^git commit'; then
  exit 0
fi

# Get list of staged .ts/.tsx files
STAGED_TS=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '\.(ts|tsx)$')

if [ -z "$STAGED_TS" ]; then
  exit 0
fi

# Determine which packages/apps have staged changes
AFFECTED_PACKAGES=""

for file in $STAGED_TS; do
  # Extract the package path (apps/X or packages/X)
  pkg=$(echo "$file" | sed -n 's|^\(apps/[^/]*\)/.*|\1|p; s|^\(packages/[^/]*\)/.*|\1|p')
  if [ -n "$pkg" ] && [ -f "$pkg/tsconfig.json" ]; then
    AFFECTED_PACKAGES="$AFFECTED_PACKAGES $pkg"
  fi
done

# Deduplicate
AFFECTED_PACKAGES=$(echo "$AFFECTED_PACKAGES" | tr ' ' '\n' | sort -u | tr '\n' ' ')

if [ -z "$AFFECTED_PACKAGES" ]; then
  exit 0
fi

# Type-check each affected package
FAILED=""
for pkg in $AFFECTED_PACKAGES; do
  echo "Type-checking $pkg..." >&2
  if ! (cd "$pkg" && npx tsc --noEmit 2>&1 | tail -5) >&2; then
    FAILED="$FAILED $pkg"
  fi
done

if [ -n "$FAILED" ]; then
  echo "" >&2
  echo "========================================" >&2
  echo "COMMIT BLOCKED: TypeScript errors in:$FAILED" >&2
  echo "Fix the type errors before committing." >&2
  echo "Run: pnpm build --filter=<package> to see full errors." >&2
  echo "========================================" >&2
  echo ""
  echo "COMMIT BLOCKED: TypeScript errors found in:$FAILED. Fix type errors before committing."
  exit 2
fi

exit 0
