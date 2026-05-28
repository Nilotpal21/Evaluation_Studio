#!/bin/bash
#
# Claude Code PreToolUse hook: warn on large commits.
#
# Advisory-only hook that warns when a commit touches too many files
# or spans too many packages. This is a softer companion to
# commit-scope-guard.sh which blocks at 40 files / 3 packages.
#
# Thresholds (warn, never block):
#   - >50 files changed
#   - >3 distinct packages (apps/X or packages/X)
#
# Exit codes:
#   0 — always (advisory only, never blocks)
#

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check Bash tool
if [ "$TOOL" != "Bash" ]; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only intercept git commit commands
if ! echo "$COMMAND" | grep -qE '^git commit'; then
  exit 0
fi

# Get staged files
STAGED=$(git diff --cached --name-only 2>/dev/null)

if [ -z "$STAGED" ]; then
  exit 0
fi

FILE_COUNT=$(echo "$STAGED" | wc -l | xargs)

# Count distinct packages (top-2 path segments under apps/ and packages/)
PACKAGES=$(echo "$STAGED" | sed -n 's|^\(apps/[^/]*\)/.*|\1|p; s|^\(packages/[^/]*\)/.*|\1|p' | sort -u)
PKG_COUNT=0
if [ -n "$PACKAGES" ]; then
  PKG_COUNT=$(echo "$PACKAGES" | wc -l | xargs)
fi

WARNINGS=""

if [ "$FILE_COUNT" -gt 50 ]; then
  WARNINGS="${WARNINGS}  - ${FILE_COUNT} files staged (threshold: 50)\n"
fi

if [ "$PKG_COUNT" -gt 3 ]; then
  WARNINGS="${WARNINGS}  - ${PKG_COUNT} packages touched (threshold: 3)\n"
  WARNINGS="${WARNINGS}    Packages: $(echo "$PACKAGES" | tr '\n' ', ' | sed 's/,$//')\n"
fi

if [ -n "$WARNINGS" ]; then
  echo "" >&2
  echo "WARNING: Large commit detected:" >&2
  echo -e "$WARNINGS" >&2
  echo "Consider splitting into smaller, focused commits — one concern per commit." >&2
  echo "" >&2
  echo "Tips:" >&2
  echo "  - Separate feature code from test code" >&2
  echo "  - Separate changes across different packages" >&2
  echo "  - Separate refactors from new features" >&2
  echo "" >&2
  echo "See CLAUDE.md: 'Commit Discipline' rules." >&2
  # Advisory only — never blocks
  exit 0
fi

exit 0
