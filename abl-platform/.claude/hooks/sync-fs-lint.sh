#!/usr/bin/env bash
# sync-fs-lint.sh — Warns on fs.*Sync calls in async server code
#
# CLAUDE.md rule: "fs.promises for all file I/O in server code — no sync I/O in async paths"

set -euo pipefail

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

if [ "$TOOL" = "Write" ]; then
  FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
else
  exit 0
fi

[ -z "$FILE" ] && exit 0

# Only check server code
case "$FILE" in
  */apps/runtime/src/*|*/apps/search-ai/src/*|*/apps/admin/src/*|*/packages/*/src/*)
    ;;
  *)
    exit 0
    ;;
esac

# Skip test files, scripts, CLI tools
case "$FILE" in
  *__tests__/*|*.test.*|*.spec.*|*/test/*|*/scripts/*|*/cli/*)
    exit 0
    ;;
esac

# Check for synchronous fs calls
VIOLATIONS=$(echo "$CONTENT" | grep -nE '\bfs\.\w+Sync\b' 2>/dev/null || true)

if [ -n "$VIOLATIONS" ]; then
  COUNT=$(echo "$VIOLATIONS" | wc -l | tr -d ' ')
  echo "WARNING: $COUNT synchronous fs call(s) in server code."
  echo "  File: $FILE"
  echo "  Use fs.promises (readFile, writeFile, etc.) instead of sync variants."
  echo ""
  echo "  Violations:"
  echo "$VIOLATIONS" | head -5
  exit 0
fi

exit 0
