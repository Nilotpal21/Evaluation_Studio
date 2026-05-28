#!/bin/bash
#
# Claude Code PreToolUse hook: auto-format staged files before git commit.
#
# Why: lint-staged runs `prettier --check` and stashes/restores the working tree.
# If any staged file fails the check, lint-staged's stash restore silently reverts
# ALL uncommitted edits — not just the failing file. This hook prevents that by
# running `prettier --write` on staged files BEFORE the commit reaches lint-staged.
#

# Ensure NVM-managed Node is on PATH for subshell environments
export NVM_DIR="$HOME/.nvm"
[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && \. "/opt/homebrew/opt/nvm/nvm.sh" 2>/dev/null
export PATH="/opt/homebrew/bin:$PATH"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only intercept git commit commands
if ! echo "$COMMAND" | grep -qE '^git commit'; then
  exit 0
fi

# Get list of staged files that prettier can format
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '\.(ts|tsx|js|jsx|json|md|yaml|yml|css|html)$')

if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

# Run prettier --write on staged files, then re-stage them
# Do NOT suppress stderr — if prettier fails, the commit must be blocked
# to prevent lint-staged's stash/restore from silently reverting edits.
if ! echo "$STAGED_FILES" | xargs npx prettier --write; then
  echo "BLOCKED: prettier --write failed on staged files. Fix syntax errors before committing."
  exit 2
fi
echo "$STAGED_FILES" | xargs git add

exit 0
