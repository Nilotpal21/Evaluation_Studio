#!/bin/bash
#
# Claude Code PreToolUse hook: guard against mega-commits.
#
# Problem: AI agents bundle multiple concerns into single commits (165 files,
# 11 packages, 24K lines). These are impossible to review, revert, or bisect.
#
# Incident: 8d66e0fdb — 3 sprints squashed into 1 commit (165 files, 11 packages,
# 24,205 lines). Multiple 30-50 file commits followed, each requiring 2-3 fix commits.
#
# Thresholds:
#   BLOCK if staged files > 40 (hard limit)
#   BLOCK if distinct packages (apps/X or packages/X) > 3
#   WARN if staged files > 20
#
# Exceptions:
#   - docs-only commits (all files under docs/)
#   - lockfile-only commits (pnpm-lock.yaml)
#   - Commit message contains "rebase" or "merge" (conflict resolution)
#   - Infra-only commits (only Dockerfiles, CI configs, .nvmrc, .node-version)
#
# Exit codes:
#   0 — pass
#   2 — block
#

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only intercept git commit commands
if ! echo "$COMMAND" | grep -qE '^git commit'; then
  exit 0
fi

# Allow rebase/merge conflict resolution commits
if echo "$COMMAND" | grep -qiE 'rebase|merge'; then
  exit 0
fi

# Get staged files
STAGED=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null)

if [ -z "$STAGED" ]; then
  exit 0
fi

FILE_COUNT=$(echo "$STAGED" | wc -l | xargs)

# Check if all staged files are docs
# Also excludes generated build artifacts (helix dist/) — these are categorically
# different from hand-written code that needs review.
NON_DOC_FILES=$(echo "$STAGED" | grep -v '^docs/' | grep -v 'pnpm-lock.yaml' | grep -v '\.md$' | grep -v '^packages/helix/dist/')
if [ -z "$NON_DOC_FILES" ]; then
  exit 0  # docs-only, lockfile-only, or generated-artifact-only commit — no scope limit
fi

# Check if all staged files are infra-only (Dockerfiles, CI configs, version files)
INFRA_PATTERN='Dockerfile\|\.harness/\|\.github/\|\.claude/\|\.nvmrc\|\.node-version\|\.tool-versions\|docker-compose'
NON_INFRA_FILES=$(echo "$STAGED" | grep -v "$INFRA_PATTERN" | grep -v '^docs/' | grep -v 'pnpm-lock.yaml' | grep -v '\.md$')
# Allow infra-only commits with just package.json engine changes
if [ -n "$NON_INFRA_FILES" ]; then
  # Check if the only non-infra file is package.json (engine version bump)
  ONLY_PKG_JSON=$(echo "$NON_INFRA_FILES" | grep -v '^package\.json$')
  if [ -z "$ONLY_PKG_JSON" ]; then
    NON_INFRA_FILES=""
  fi
fi
if [ -z "$NON_INFRA_FILES" ]; then
  exit 0  # infra-only commit (Dockerfiles, CI, version pins) — no scope limit
fi

NON_DOC_COUNT=$(echo "$NON_DOC_FILES" | wc -l | xargs)

# Count distinct packages (apps/X or packages/X)
PACKAGES=$(echo "$NON_DOC_FILES" | sed -n 's|^\(apps/[^/]*\)/.*|\1|p; s|^\(packages/[^/]*\)/.*|\1|p' | sort -u)
PKG_COUNT=0
if [ -n "$PACKAGES" ]; then
  PKG_COUNT=$(echo "$PACKAGES" | wc -l | xargs)
fi

# Hard block: >40 non-doc files
if [ "$NON_DOC_COUNT" -gt 40 ]; then
  echo ""
  echo "BLOCKED: Commit touches $NON_DOC_COUNT files (limit: 40)."
  echo ""
  echo "This commit is too large to review, revert, or bisect safely."
  echo "Split into smaller, focused commits — one concern per commit."
  echo ""
  echo "Packages touched ($PKG_COUNT): $(echo "$PACKAGES" | tr '\n' ', ' | sed 's/,$//')"
  echo ""
  echo "Tips:"
  echo "  - Separate feature code from test code"
  echo "  - Separate changes across different packages"
  echo "  - Separate refactors from new features"
  echo "  - Commit docs separately from code"
  echo ""
  echo "See CLAUDE.md: 'Commit Discipline' rules."
  exit 2
fi

# Hard block: >3 packages
if [ "$PKG_COUNT" -gt 3 ]; then
  echo ""
  echo "BLOCKED: Commit touches $PKG_COUNT packages (limit: 3)."
  echo ""
  echo "Cross-package commits are high-risk — a regression in any package"
  echo "is impossible to isolate via git bisect."
  echo ""
  echo "Packages: $(echo "$PACKAGES" | tr '\n' ', ' | sed 's/,$//')"
  echo ""
  echo "Split into one commit per package, or group tightly-coupled packages"
  echo "(max 3) that must change atomically."
  echo ""
  echo "See CLAUDE.md: 'Commit Discipline' rules."
  exit 2
fi

# Soft warn: >20 non-doc files
if [ "$NON_DOC_COUNT" -gt 20 ]; then
  echo "" >&2
  echo "WARNING: Commit touches $NON_DOC_COUNT files across $PKG_COUNT package(s)." >&2
  echo "Consider splitting into smaller commits for easier review and revert." >&2
  echo "Packages: $(echo "$PACKAGES" | tr '\n' ', ' | sed 's/,$//')" >&2
  echo "" >&2
  # Non-blocking warning
  exit 0
fi

exit 0
