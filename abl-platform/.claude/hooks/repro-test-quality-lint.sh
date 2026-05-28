#!/bin/bash
#
# Claude Code PreToolUse hook: block low-confidence repro tests.
#
# Repro tests are bug contracts. They must execute, assert expected behavior,
# use real platform code, and fail for the product gap instead of setup errors.
#

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

case "$TOOL" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if ! echo "$FILE_PATH" | grep -qiE '\.repro\.(test|spec)\.(ts|tsx)$'; then
  exit 0
fi

CONTENT=""
if [ "$TOOL" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
fi

REPO_ROOT=$(git -C "$(dirname "$FILE_PATH")" rev-parse --show-toplevel 2>/dev/null || pwd)

printf '%s' "$CONTENT" | node "$REPO_ROOT/tools/repro-test-quality-check.mjs" --path "$FILE_PATH" --stdin
