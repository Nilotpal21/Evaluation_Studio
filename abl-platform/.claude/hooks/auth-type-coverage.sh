#!/bin/bash
#
# Claude Code PreToolUse hook: run auth-type coverage drift lint before commit.
# Blocks commits when Studio-supported auth types are missing runtime or matrix
# coverage wiring.

set -euo pipefail

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

if [ "$TOOL" != "Bash" ]; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if ! echo "$COMMAND" | grep -qE '^git commit'; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_DIR"

if ! bash "$PROJECT_DIR/tools/auth-type-coverage.sh"; then
  echo ""
  echo "COMMIT BLOCKED: auth-type coverage drift lint failed."
  echo "Fix the reported missing coverage before committing."
  exit 2
fi

exit 0

