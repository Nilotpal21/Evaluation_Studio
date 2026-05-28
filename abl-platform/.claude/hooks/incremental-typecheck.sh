#!/bin/bash
#
# Claude Code PostToolUse hook: incremental typecheck after writing .ts files.
#
# Problem: The typecheck-before-commit hook catches errors at commit time, but
# by then the agent may have written 8+ broken files and has to untangle them
# all at once. This hook catches errors immediately after each file write.
#
# Incident: 9e7fe8074 wrote 8 files with cascading type errors that weren't
# caught until commit time. The follow-up fix (9b31f15b5) had to resolve 35
# TypeScript errors across 8 files.
#
# Behavior:
#   - Runs after Write or Edit on .ts/.tsx files (PostToolUse)
#   - Determines which package the file belongs to
#   - Runs tsc --noEmit on that package
#   - If errors found, reports them immediately so the agent can fix before moving on
#
# Performance: tsc --noEmit on a single package takes 2-8 seconds. This is
# acceptable as a PostToolUse hook since it runs after the write completes.
#
# Exit codes:
#   0 — pass (no errors, or not a .ts file, or package not found)
#   1 — type errors found (non-blocking warning — agent should fix before proceeding)
#

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check Write and Edit tools
case "$TOOL" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only check TypeScript files
case "$FILE_PATH" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

# Skip test files — type errors in tests are less urgent during implementation
case "$FILE_PATH" in
  *__tests__*|*.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx) exit 0 ;;
esac

# Skip declaration files and generated files
case "$FILE_PATH" in
  *.d.ts|*/dist/*|*/build/*|*/node_modules/*|*/.next/*) exit 0 ;;
esac

# Determine which package this file belongs to
PKG_DIR=""
RELATIVE_PATH="$FILE_PATH"

# Try to extract apps/X or packages/X
PKG_DIR=$(echo "$RELATIVE_PATH" | sed -n 's|^\(.*/\)\?\(apps/[^/]*\)/.*|\2|p; s|^\(.*/\)\?\(packages/[^/]*\)/.*|\2|p')

if [ -z "$PKG_DIR" ]; then
  exit 0  # File not in a recognized package
fi

# Check if the package has a tsconfig.json
if [ ! -f "$PKG_DIR/tsconfig.json" ]; then
  exit 0
fi

# Run tsc --noEmit on the package
# Capture output but limit to first 20 lines to avoid flooding
TSC_OUTPUT=$(cd "$PKG_DIR" && npx tsc --noEmit 2>&1 | head -30)
TSC_EXIT=$?

if [ $TSC_EXIT -ne 0 ]; then
  ERROR_COUNT=$(echo "$TSC_OUTPUT" | grep -c "error TS" || echo "0")
  echo "" >&2
  echo "TypeScript errors in $PKG_DIR after editing $FILE_PATH:" >&2
  echo "$TSC_OUTPUT" >&2
  if [ "$ERROR_COUNT" -gt 20 ]; then
    echo "... and more ($ERROR_COUNT total errors). Run: cd $PKG_DIR && npx tsc --noEmit" >&2
  fi
  echo "" >&2
  echo "Fix these type errors before editing more files — cascading errors compound." >&2
  echo "" >&2
  # Exit 0 — non-blocking. We want the agent to see the errors but not lose the edit.
  # The commit-time typecheck will block if errors persist.
  exit 0
fi

exit 0
