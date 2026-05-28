#!/bin/bash
#
# Claude Code PreToolUse hook: block synchronous file I/O in server-side code.
#
# Server code must use `fs.promises` (async) for all file I/O.
# See CLAUDE.md Key Rules.
#

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check Write and Edit tools
case "$TOOL" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

# Get the file path being written/edited
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only check .ts/.tsx files
case "$FILE_PATH" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

# Only check server-side paths
case "$FILE_PATH" in
  */apps/runtime/*|*/apps/admin/*|*/apps/search-ai/*|*/apps/workflow-engine/*|*/packages/*) ;;
  *) exit 0 ;;
esac

# Skip client-side (studio), test files, scripts, CLI tools, and legitimate sync I/O paths
case "$FILE_PATH" in
  */apps/studio/*) exit 0 ;;
  */__tests__/*|*.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx) exit 0 ;;
  */scripts/*) exit 0 ;;
  */cli/*) exit 0 ;;
  */eventstore/src/resilience/*) exit 0 ;;  # WAL requires sync for durability
  */pipeline-engine/src/pipeline/trigger-registry*) exit 0 ;;  # Startup config
  */redis/src/connection*) exit 0 ;;  # Connection setup
esac

# Get the content being written
CONTENT=""
if [ "$TOOL" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
fi

# Check for synchronous file I/O patterns
if echo "$CONTENT" | grep -qE '\b(readFileSync|writeFileSync|existsSync|mkdirSync|readdirSync|statSync|unlinkSync|copyFileSync|renameSync|accessSync|appendFileSync|chmodSync|rmdirSync)\b'; then
  MATCHED=$(echo "$CONTENT" | grep -oE '\b(readFileSync|writeFileSync|existsSync|mkdirSync|readdirSync|statSync|unlinkSync|copyFileSync|renameSync|accessSync|appendFileSync|chmodSync|rmdirSync)\b' | sort -u | head -5)
  echo ""
  echo "Synchronous file I/O detected: $MATCHED"
  echo ""
  echo "Synchronous file I/O detected. Use \`fs.promises\` (async) for all file I/O in server code. See CLAUDE.md Key Rules."
  exit 2
fi

exit 0
