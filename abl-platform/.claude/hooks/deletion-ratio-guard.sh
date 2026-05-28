#!/bin/bash
#
# Claude Code PreToolUse hook: warn when feat commits have high deletion ratios.
#
# Problem: Feature commits that delete >20% of their total churn are usually
# disguised refactors — rewriting existing code under a "feat" label. This
# masks the risk of behavioral regressions from rewritten code.
#
# Incident: 9e7fe8074 had a 55% deletion ratio (1,268 deleted vs 1,044 added)
# while labeled as feat(). It rewrote runtime-executor.ts and deleted ~20 type
# definitions, causing 35 TypeScript errors.
#
# Behavior:
#   - Only checks `git commit` commands whose message starts with feat(
#   - Computes insertion/deletion ratio from staged diff
#   - BLOCKS if deletions > 30% of total churn AND deletions > 50 lines
#   - WARNS if deletions > 20% of total churn AND deletions > 30 lines
#
# Exit codes:
#   0 — pass (or non-feat commit)
#   2 — block
#

INPUT=$(cat)
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

if ! echo "$COMMIT_MSG" | grep -qE '^\[?[A-Z].*feat\(' && ! echo "$COMMAND" | grep -qE 'feat\('; then
  exit 0  # Not a feat commit
fi

# Get staged diff stats
STATS=$(git diff --cached --shortstat 2>/dev/null)

if [ -z "$STATS" ]; then
  exit 0
fi

# Parse insertions and deletions
INSERTIONS=$(echo "$STATS" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo "0")
DELETIONS=$(echo "$STATS" | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' || echo "0")

if [ -z "$INSERTIONS" ]; then INSERTIONS=0; fi
if [ -z "$DELETIONS" ]; then DELETIONS=0; fi

TOTAL=$((INSERTIONS + DELETIONS))

if [ "$TOTAL" -eq 0 ]; then
  exit 0
fi

# Calculate deletion percentage
DEL_PCT=$((DELETIONS * 100 / TOTAL))

# Hard block: >30% deletions AND >50 lines deleted in a feat commit
if [ "$DEL_PCT" -gt 30 ] && [ "$DELETIONS" -gt 50 ]; then
  echo ""
  echo "BLOCKED: feat() commit has ${DEL_PCT}% deletions (+${INSERTIONS}/-${DELETIONS})."
  echo ""
  echo "Feature commits should be additive — adding new code, not rewriting existing code."
  echo "A deletion ratio above 30% indicates this is a refactor disguised as a feature."
  echo ""
  echo "Options:"
  echo "  1. Split into a refactor() commit (deletions/rewrites) + feat() commit (new code)"
  echo "  2. Change the commit type to refactor() if this is purely restructuring"
  echo "  3. If you're replacing an old implementation, commit the removal separately first"
  echo ""
  echo "See CLAUDE.md: 'Commit Discipline' rules."
  exit 2
fi

# Soft warn: >20% deletions AND >30 lines deleted
if [ "$DEL_PCT" -gt 20 ] && [ "$DELETIONS" -gt 30 ]; then
  echo "" >&2
  echo "WARNING: feat() commit has ${DEL_PCT}% deletions (+${INSERTIONS}/-${DELETIONS})." >&2
  echo "Feature commits should be mostly additive. Consider splitting refactoring" >&2
  echo "into a separate refactor() commit." >&2
  echo "" >&2
  # Non-blocking warning
  exit 0
fi

exit 0
