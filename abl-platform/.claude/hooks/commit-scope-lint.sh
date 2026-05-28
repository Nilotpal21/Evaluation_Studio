#!/bin/bash
#
# Claude Code PreToolUse hook: warn when feat commits have high deletion ratios.
#
# This is a softer, advisory-only variant of deletion-ratio-guard.sh.
# It warns (never blocks) when a feat() commit has >30% deletions,
# suggesting the deletions be split into a separate refactor() commit.
#
# Unlike deletion-ratio-guard.sh which blocks at >30%/>50 lines,
# this hook warns at >30% regardless of absolute line count.
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

# Only check feat() commits — extract message from -m flag
COMMIT_MSG=$(echo "$COMMAND" | sed -n "s/.*-m ['\"]\\(.*\\)['\"].*/\\1/p")
# Also handle heredoc-style messages
if [ -z "$COMMIT_MSG" ]; then
  COMMIT_MSG=$(echo "$COMMAND" | grep -oE 'feat\(' || true)
fi

if ! echo "$COMMIT_MSG" | grep -qE 'feat\(' && ! echo "$COMMAND" | grep -qE 'feat\('; then
  exit 0  # Not a feat commit
fi

# Get staged diff numstat for per-file insertion/deletion counts
NUMSTAT=$(git diff --cached --numstat 2>/dev/null)

if [ -z "$NUMSTAT" ]; then
  exit 0
fi

# Sum insertions and deletions from numstat output
TOTAL_ADD=0
TOTAL_DEL=0
while IFS=$'\t' read -r added deleted _file; do
  # Skip binary files (shown as "-")
  if [ "$added" = "-" ] || [ "$deleted" = "-" ]; then
    continue
  fi
  TOTAL_ADD=$((TOTAL_ADD + added))
  TOTAL_DEL=$((TOTAL_DEL + deleted))
done <<< "$NUMSTAT"

TOTAL=$((TOTAL_ADD + TOTAL_DEL))

if [ "$TOTAL" -eq 0 ]; then
  exit 0
fi

# Calculate deletion percentage
DEL_PCT=$((TOTAL_DEL * 100 / TOTAL))

# Warn if deletion ratio exceeds 30%
if [ "$DEL_PCT" -gt 30 ]; then
  echo "" >&2
  echo "WARNING: feat() commit has ${DEL_PCT}% deletions (+${TOTAL_ADD}/-${TOTAL_DEL})." >&2
  echo "" >&2
  echo "Feature commits should be additive — mostly new code, not rewrites." >&2
  echo "A deletion ratio above 30% suggests this includes refactoring work." >&2
  echo "" >&2
  echo "Consider splitting into:" >&2
  echo "  1. A refactor() commit for deletions/rewrites" >&2
  echo "  2. A feat() commit for the new code" >&2
  echo "" >&2
  echo "See CLAUDE.md: 'Commit Discipline' rules." >&2
  # Advisory only — never blocks
  exit 0
fi

exit 0
